import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import {
  ListTasksCommand,
  DescribeTasksCommand,
  StopTaskCommand,
} from "@aws-sdk/client-ecs";
import type { AwsComputeConnectionModel as AwsComputeConnection } from "@withvibe/db";
import { PrismaService } from "../../prisma/prisma.service";
import { EnvComputeService } from "../env-compute.service";
import { AwsClientsService } from "./aws-clients.service";
import { TraefikDynamicService } from "./traefik-dynamic.service";
import { diffTasksVsEnvs, isIdle } from "./fargate-reap-logic";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/** Prefix FargateDriver stamps on RunTask's `startedBy`, followed by the env id. */
const STARTED_BY_PREFIX = "wv-";

/** Default minutes of no user activity before a sandbox is stopped. */
const DEFAULT_IDLE_MINUTES = 60;

/** How often the idle sweep runs. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Cost control for the `fargate` compute target. Fargate bills per second for
 * as long as a task exists, so a sandbox nobody remembers is a bill nobody
 * authorized. Two jobs:
 *
 *  - **Reconcile at boot** — the DB's view of which envs are running is
 *    process-local state that a restart can desynchronize from ECS in both
 *    directions. A task still RUNNING under an env the DB calls stopped is an
 *    orphan that bills forever; an env the DB calls running whose task is gone
 *    is a lie the UI shows the user. We fix both against live ECS.
 *
 *  - **Idle sweep** — stop running envs whose last user-initiated activity
 *    (EnvComputeService.touchActivity) is older than the timeout.
 *
 * Both only ever touch tasks whose `startedBy` begins with `wv-`: the cluster
 * belongs to the *client's* AWS account and may legitimately run their own
 * workloads, which we must never stop.
 *
 * Tunables: `FARGATE_IDLE_TIMEOUT_MINUTES` (0 disables the sweep — reconcile
 * still runs, since orphans are a correctness problem, not a policy one).
 */
@Injectable()
export class FargateReaperService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectPinoLogger(FargateReaperService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly compute: EnvComputeService,
    private readonly aws: AwsClientsService,
    private readonly traefik: TraefikDynamicService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Never let reaper trouble block API startup.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    // Don't hold the event loop open on shutdown.
    this.timer.unref?.();
  }

  /**
   * Reconcile, then sweep. Reconcile doesn't only matter at boot — a stop
   * that failed mid-flight, or a task killed outside the platform, strands
   * state at any time. Order matters: reconciling first means the sweep acts
   * on a fresh picture rather than stopping envs AWS already forgot.
   */
  private async tick(): Promise<void> {
    try {
      await this.reconcile();
    } catch (err) {
      this.logger.error(`[fargate-reaper] reconcile failed: ${msg(err)}`);
    }
    try {
      await this.sweepIdle();
    } catch (err) {
      this.logger.error(`[fargate-reaper] idle sweep failed: ${msg(err)}`);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get idleTimeoutMinutes(): number {
    const raw = process.env.FARGATE_IDLE_TIMEOUT_MINUTES?.trim();
    if (!raw) return DEFAULT_IDLE_MINUTES;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_MINUTES;
  }

  // ---------- boot reconcile -------------------------------------------------

  /**
   * Walk every connected client cluster and settle DB-vs-ECS disagreements.
   * Returns counts for logging/tests.
   */
  async reconcile(): Promise<{ orphansStopped: number; envsMarkedStopped: number }> {
    const conns = await this.prisma.client.awsComputeConnection.findMany({
      where: { status: "ok" },
    });
    let orphansStopped = 0;
    let envsMarkedStopped = 0;

    for (const conn of conns) {
      if (!conn.clusterArn || !conn.roleArn || !conn.region) continue;
      let live: Map<string, string>;
      try {
        live = await this.liveTasksByEnv(conn);
      } catch (err) {
        // An unreachable client account is not our problem to solve here —
        // leave its envs alone rather than mass-flipping them to stopped.
        this.logger.warn(
          `[fargate-reaper] could not list tasks for workspace ${conn.workspaceId}: ${msg(err)}`
        );
        continue;
      }

      const envs = await this.prisma.client.env.findMany({
        where: { workspaceId: conn.workspaceId, computeTarget: "fargate" },
        select: {
          id: true,
          containerStatus: true,
          deletedAt: true,
          fargateTaskArn: true,
        },
      });
      const { orphanEnvIds, ghostEnvIds } = diffTasksVsEnvs({
        liveTasks: live,
        envs,
      });

      // ECS says running, we don't → orphan. Bills until stopped.
      for (const envId of orphanEnvIds) {
        const taskArn = live.get(envId)!;
        try {
          await this.stopTask(conn, taskArn, "withvibe reaper: orphaned task");
          orphansStopped++;
          this.logger.warn(
            `[fargate-reaper] stopped orphaned task for env ${envId}`
          );
          await this.traefik.removeEnvRoutes(envId).catch(() => undefined);
        } catch (err) {
          this.logger.error(
            `[fargate-reaper] failed to stop orphaned task ${taskArn}: ${msg(err)}`
          );
        }
      }

      // We say running, ECS doesn't → the task died (spot reclaim, crash,
      // manual stop in the AWS console). Tell the truth in the UI.
      for (const ghostId of ghostEnvIds) {
        await this.prisma.client.env.update({
          where: { id: ghostId },
          data: {
            containerStatus: "stopped",
            containerError: "Task is no longer running in AWS.",
            fargateTaskArn: null,
            fargatePublicIp: null,
            fargateBridgeCert: null,
          },
        });
        await this.traefik.removeEnvRoutes(ghostId).catch(() => undefined);
        envsMarkedStopped++;
      }
      if (ghostEnvIds.length > 0) {
        this.logger.warn(
          `[fargate-reaper] marked ${ghostEnvIds.length} env(s) stopped — no live task in AWS`
        );
      }
    }

    if (orphansStopped === 0 && envsMarkedStopped === 0) {
      this.logger.info("[fargate-reaper] reconcile: DB and ECS agree");
    }
    return { orphansStopped, envsMarkedStopped };
  }

  // ---------- idle sweep -----------------------------------------------------

  /** Stop running fargate envs that nobody has touched in `idleTimeoutMinutes`. */
  async sweepIdle(): Promise<number> {
    const minutes = this.idleTimeoutMinutes;
    if (minutes === 0) return 0;
    const cutoff = new Date(Date.now() - minutes * 60_000);

    const candidates = await this.prisma.client.env.findMany({
      where: {
        computeTarget: "fargate",
        containerStatus: "running",
        deletedAt: null,
      },
      select: {
        id: true,
        title: true,
        lastActivityAt: true,
        lastContainerAt: true,
      },
    });

    let stopped = 0;
    for (const env of candidates) {
      if (!isIdle(env, cutoff)) continue;
      try {
        const driver = await this.compute.driverFor(env.id);
        await driver.stopEnvironment(env.id);
        stopped++;
        this.logger.info(
          `[fargate-reaper] stopping idle env ${env.id} ("${env.title}") — no activity for ${minutes}m`
        );
      } catch (err) {
        this.logger.error(
          `[fargate-reaper] failed to stop idle env ${env.id}: ${msg(err)}`
        );
      }
    }
    return stopped;
  }

  // ---------- AWS helpers ----------------------------------------------------

  /**
   * envId → taskArn for every withvibe-started task currently alive in the
   * connection's cluster. ECS reports a task as RUNNING right up to the moment
   * it stops, and PENDING tasks bill too, so both count as live.
   */
  private async liveTasksByEnv(
    conn: AwsComputeConnection
  ): Promise<Map<string, string>> {
    const { ecs } = this.clients(conn);
    const arns: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await ecs.send(
        new ListTasksCommand({
          cluster: conn.clusterArn!,
          desiredStatus: "RUNNING",
          nextToken,
        })
      );
      arns.push(...(page.taskArns ?? []));
      nextToken = page.nextToken;
    } while (nextToken);

    const out = new Map<string, string>();
    // DescribeTasks caps at 100 per call.
    for (let i = 0; i < arns.length; i += 100) {
      const chunk = arns.slice(i, i + 100);
      const described = await ecs.send(
        new DescribeTasksCommand({ cluster: conn.clusterArn!, tasks: chunk })
      );
      for (const task of described.tasks ?? []) {
        const startedBy = task.startedBy ?? "";
        // The client's own workloads share this cluster — never touch them.
        if (!startedBy.startsWith(STARTED_BY_PREFIX) || !task.taskArn) continue;
        out.set(startedBy.slice(STARTED_BY_PREFIX.length), task.taskArn);
      }
    }
    return out;
  }

  private async stopTask(
    conn: AwsComputeConnection,
    taskArn: string,
    reason: string
  ): Promise<void> {
    const { ecs } = this.clients(conn);
    await ecs.send(
      new StopTaskCommand({ cluster: conn.clusterArn!, task: taskArn, reason })
    );
  }

  private clients(conn: AwsComputeConnection) {
    return this.aws.clientsFor({
      roleArn: conn.roleArn!,
      externalId: conn.externalId,
      region: conn.region!,
    });
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
