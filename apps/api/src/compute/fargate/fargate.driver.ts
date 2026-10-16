import { BadRequestException, Injectable } from "@nestjs/common";
import { readFile } from "fs/promises";
import path from "path";
import {
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  ExecuteCommandCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import * as pty from "node-pty";
import { DescribeNetworkInterfacesCommand } from "@aws-sdk/client-ec2";
import {
  GetLogEventsCommand,
  FilterLogEventsCommand,
  DescribeLogStreamsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import type { AwsComputeConnectionModel as AwsComputeConnection } from "@withvibe/db";
import { PrismaService } from "../../prisma/prisma.service";
import { DockerService } from "../../docker/docker.service";
import { EnvLogBufferService } from "../env-log-buffer.service";
import { AwsClientsService } from "./aws-clients.service";
import { AwsConnectionService } from "./aws-connection.service";
import { TraefikDynamicService } from "./traefik-dynamic.service";
import { EfsStorageService } from "./efs-storage.service";
import { GitProxyService } from "../../git-proxy/git-proxy.service";
import { SandboxReposService } from "./sandbox-repos.service";
import { DEPLOYMENT_TAG_KEY, deploymentId } from "./deployment-id";
import {
  FargateExecService,
  FARGATE_BRIDGE_PORT,
  fargateApiBaseUrl,
} from "./fargate-exec.service";
import {
  translateComposeToTaskDef,
  ComposeTranslateError,
} from "./compose-to-taskdef";
import type {
  EnvComputeDriver,
  EnvContainersResult,
  LogStreamHandle,
  ServiceLifecycleAction,
  ServiceLogsResult,
  ShellSession,
} from "../env-compute-driver";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/** How long to wait for a RunTask'd task to reach RUNNING + get an IP. */
/**
 * The runner's working directory volume. Declared by the driver rather than by
 * the compose file, so it has to be given persistence explicitly — without
 * that, anything the AI writes (and, once repos clone in-task, the checkout
 * itself) is destroyed every time the env stops, including by the idle timeout.
 */
const WORKSPACE_VOLUME = "withvibe-workspace";

/**
 * The container that clones the env's repositories. It runs to completion and
 * exits; it exists as a container rather than as a command we send into the
 * task because only a container can be depended on — a compose service that
 * mounts a repository must not start until the code is actually there.
 */
const REPO_INIT_CONTAINER = "withvibe-repos";

const START_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 4_000;

/**
 * The `fargate` compute target: the env's compose file is translated into a
 * single ECS task definition and run on the CLIENT account's cluster (see
 * AwsConnectionService / infra/aws/withvibe-client-compute.cfn.yaml). All
 * control-plane traffic is AWS API calls under the client's
 * withvibe-platform-access role — the platform needs no network path into
 * the client VPC except the task's SG-guarded public IP (Phase 2 routing).
 *
 * Lifecycle output lands in the same EnvLogBufferService the local driver
 * uses, so the UI log panel and the agent's get_env_logs behave identically.
 */
@Injectable()
export class FargateDriver implements EnvComputeDriver {
  readonly target = "fargate" as const;

  constructor(
    @InjectPinoLogger(FargateDriver.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly docker: DockerService,
    private readonly logBuffer: EnvLogBufferService,
    private readonly aws: AwsClientsService,
    private readonly connections: AwsConnectionService,
    private readonly traefik: TraefikDynamicService,
    private readonly efs: EfsStorageService,
    private readonly bridge: FargateExecService,
    private readonly gitProxy: GitProxyService,
    private readonly sandboxRepos: SandboxReposService
  ) {}

  // ---------- lifecycle ------------------------------------------------------

  async startEnvironment(envId: string): Promise<void> {
    await this.setStatus(envId, "starting", { error: null });
    void this.startBg(envId);
  }

  async stopEnvironment(
    envId: string,
    // `purgeVolumes` is the DELETE path. A plain stop must leave EFS-backed
    // storage alone — that is the whole point of it — but deleting the env
    // should take its access points (and so its data) with it, or a workspace
    // accumulates orphaned directories nobody can reach.
    options: { purgeVolumes?: boolean } = {}
  ): Promise<void> {
    await this.setStatus(envId, "stopping", { error: null });
    void this.stopBg(envId, { purgeVolumes: options.purgeVolumes === true });
  }

  async rebuildEnvironment(envId: string): Promise<void> {
    // Images-only: "rebuild" = stop the task and run a fresh one (which
    // re-registers the task definition and re-pulls image tags).
    await this.setStatus(envId, "building", { error: null });
    void (async () => {
      try {
        await this.stopBg(envId, { silent: true });
        await this.startBg(envId);
      } catch (err) {
        await this.fail(envId, `rebuild failed: ${this.errMsg(err)}`);
      }
    })();
  }

  async serviceAction(
    _envId: string,
    service: string,
    action: ServiceLifecycleAction
  ): Promise<void> {
    throw new BadRequestException(
      `Per-service ${action} isn't supported on Fargate envs — containers live and die with the task. ` +
        `Use env-level stop/start/rebuild instead (service: ${service}).`
    );
  }

  private async startBg(envId: string): Promise<void> {
    this.logBuffer.clear(envId);
    const log = (line: string) => this.logBuffer.push(envId, line);
    try {
      const env = await this.prisma.client.env.findUnique({
        where: { id: envId },
        select: { workspaceId: true, routingBaseDomain: true },
      });
      if (!env) throw new Error("Environment not found");
      const conn = await this.connections.getVerified(env.workspaceId);

      log(`[fargate] resolving compose file…\n`);
      const ctx = await this.docker.getEnvironmentCompose(envId);
      if ("error" in ctx) {
        await this.fail(envId, ctx.error);
        return;
      }
      const composeYaml = await readFile(ctx.composeFile, "utf-8");
      const dotEnv = await this.readDotEnv(ctx.envDir);

      log(`[fargate] translating compose → ECS task definition…\n`);
      // A compose file written for a local env bind-mounts its repositories
      // from the host. The task clones those same repositories into its
      // workspace, so the translator can resolve such a mount — but only if it
      // knows which names are repositories rather than stray host paths.
      const envRepos = await this.prisma.client.envRepo.findMany({
        where: { envId },
        include: { repo: { select: { name: true } } },
      });
      const repoNames = envRepos.map((er) => er.repo.name);

      // Which named volumes this compose uses — resolved by translating once
      // with no storage, so the access points we create match exactly the
      // volumes that will be mounted.
      const probe = translateComposeToTaskDef({
        composeYaml,
        dotEnv,
        family: this.family(envId),
        logGroupName: conn.logGroupName!,
        region: conn.region!,
        executionRoleArn: conn.taskExecutionRoleArn!,
        taskRoleArn: conn.taskRoleArn!,
        repoNames,
      });
      const volumeNames = (probe.taskDefinition.volumes ?? [])
        .map((v) => v.name)
        .filter((n): n is string => !!n);

      // One access point per volume, created on first start and reused after.
      // Without a filesystem (a stack that predates EFS) this stays empty and
      // the volumes remain the scratch space they always were.
      // The runner's /workspace is declared by us, not by the compose file,
      // so it needs its own access point — and it is the one that matters most
      // once repositories are cloned inside the task.
      let workspaceAccessPointId: string | null = null;
      if (conn.fileSystemId) {
        workspaceAccessPointId = await this.efs.ensureAccessPoint(
          conn,
          envId,
          WORKSPACE_VOLUME
        );
      }

      const volumeAccessPoints: Record<string, string> = {};
      if (conn.fileSystemId && volumeNames.length > 0) {
        log(`[fargate] attaching persistent storage for ${volumeNames.join(", ")}\n`);
        for (const name of volumeNames) {
          const ap = await this.efs.ensureAccessPoint(conn, envId, name);
          if (ap) volumeAccessPoints[name] = ap;
        }
      } else if (volumeNames.length > 0) {
        log(
          `[fargate] note: ${volumeNames.length} volume(s) are scratch space - ` +
            `this AWS stack has no EFS filesystem, so their contents are lost when the env stops. ` +
            `Redeploy infra/aws/withvibe-client-compute.cfn.yaml to add persistence.\n`
        );
      }

      // A repo bind mount resolves to a subdirectory of the workspace, which
      // only an access point can express — a task-scoped volume has no way to
      // name a path inside itself. Without a filesystem the mount is simply
      // unsatisfiable, and saying so now beats a container that starts on an
      // empty directory.
      if (probe.repoMounts.length > 0 && !conn.fileSystemId) {
        await this.fail(
          envId,
          `This compose file mounts ${probe.repoMounts
            .map((m) => `./${m.workspacePath}`)
            .join(", ")} from the repository clone, which needs the EFS ` +
            `filesystem this AWS stack does not have. Redeploy ` +
            `infra/aws/withvibe-client-compute.cfn.yaml to add it.`
        );
        return;
      }
      for (const mount of probe.repoMounts) {
        const ap = await this.efs.ensureAccessPoint(
          conn,
          envId,
          mount.volumeName,
          `/${envId}/${WORKSPACE_VOLUME}/${mount.workspacePath}`
        );
        if (ap) volumeAccessPoints[mount.volumeName] = ap;
      }

      const translated = translateComposeToTaskDef({
        composeYaml,
        dotEnv,
        family: this.family(envId),
        logGroupName: conn.logGroupName!,
        region: conn.region!,
        executionRoleArn: conn.taskExecutionRoleArn!,
        taskRoleArn: conn.taskRoleArn!,
        fileSystemId: conn.fileSystemId,
        volumeAccessPoints,
        repoNames,
      });
      for (const note of translated.notes) log(`[fargate] note: ${note}\n`);

      // Repo volumes are declared here rather than by the translator: it is
      // pure, and only this layer can turn a workspace path into an access
      // point id.
      if (translated.repoMounts.length > 0) {
        translated.taskDefinition.volumes = [
          ...(translated.taskDefinition.volumes ?? []),
          ...translated.repoMounts.map((mount) => ({
            name: mount.volumeName,
            efsVolumeConfiguration: {
              fileSystemId: conn.fileSystemId!,
              transitEncryption: "ENABLED" as const,
              authorizationConfig: {
                accessPointId: volumeAccessPoints[mount.volumeName],
                iam: "ENABLED" as const,
              },
            },
          })),
        ];
      }

      // The clone that fills those mounts runs as a container in this task, so
      // the services that mount them can wait for it.
      const clonesInTask = await this.addRepoInitContainer(
        envId,
        translated.taskDefinition,
        translated.requiredRepos,
        translated.servicesNeedingRepos,
        log
      );

      // The sandbox AI: a runner container (claude CLI) rides in every
      // fargate task, serving the exec bridge the chat engine drives. The
      // bridge is fetched from the api at boot, so the task must be able to
      // reach the api on a public URL.
      const bridgeCert = await this.addRunnerContainer(
        envId,
        env.workspaceId,
        translated.taskDefinition,
        log,
        conn.fileSystemId,
        workspaceAccessPointId
      );

      const { ecs } = this.clients(conn);
      const registered = await ecs.send(
        new RegisterTaskDefinitionCommand(translated.taskDefinition)
      );
      const taskDefArn = registered.taskDefinition?.taskDefinitionArn;
      if (!taskDefArn) throw new Error("RegisterTaskDefinition returned no ARN");
      log(`[fargate] task definition ${taskDefArn.split("/").pop()}\n`);

      const subnets = JSON.parse(conn.subnetIds!) as string[];
      const run = await ecs.send(
        new RunTaskCommand({
          cluster: conn.clusterArn!,
          taskDefinition: taskDefArn,
          count: 1,
          launchType: "FARGATE",
          enableExecuteCommand: true,
          startedBy: this.startedBy(envId),
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets,
              securityGroups: [conn.securityGroupId!],
              assignPublicIp: "ENABLED",
            },
          },
          tags: [
            { key: "withvibe-env", value: envId },
            // Which control plane owns this task. The reaper refuses to stop
            // a task tagged for a different deployment — see deployment-id.ts.
            { key: DEPLOYMENT_TAG_KEY, value: deploymentId() },
          ],
        })
      );
      const failure = run.failures?.[0];
      if (failure) {
        throw new Error(`RunTask failed: ${failure.reason} ${failure.detail ?? ""}`);
      }
      const taskArn = run.tasks?.[0]?.taskArn;
      if (!taskArn) throw new Error("RunTask returned no task");
      await this.prisma.client.env.update({
        where: { id: envId },
        data: { fargateTaskArn: taskArn, fargateBridgeCert: bridgeCert },
      });
      log(`[fargate] task started: ${taskArn.split("/").pop()}\n`);

      // Wait for RUNNING + the ENI's public IP.
      const deadline = Date.now() + START_TIMEOUT_MS;
      let lastStatus = "";
      while (Date.now() < deadline) {
        const task = await this.describeTask(conn, taskArn);
        const status = task?.lastStatus ?? "UNKNOWN";
        if (status !== lastStatus) {
          lastStatus = status;
          log(`[fargate] task status: ${status}\n`);
        }
        if (status === "RUNNING") {
          const publicIp = await this.resolvePublicIp(conn, task!);
          await this.prisma.client.env.update({
            where: { id: envId },
            data: { fargatePublicIp: publicIp },
          });
          if (publicIp) log(`[fargate] task public IP: ${publicIp}\n`);
          // Publish Traefik routes (file provider) so the env gets the same
          // stable `<svc>-<short>.<base>` URLs local subdomain envs get. The
          // task IP changes on every start; the hostnames never do.
          if (publicIp && env.routingBaseDomain) {
            const urls = await this.traefik.publishEnvRoutes({
              envId,
              baseDomain: env.routingBaseDomain,
              taskIp: publicIp,
              servicePorts: translated.servicePorts,
            });
            if (Object.keys(urls).length > 0) {
              await this.prisma.client.env.update({
                where: { id: envId },
                data: { serviceUrls: urls },
              });
              for (const [svc, url] of Object.entries(urls)) {
                log(`[fargate] route: ${svc} → ${url}\n`);
              }
            }
          }
          // Repositories are cloned by the task itself, from the git proxy —
          // see SandboxReposService. Normally that happens in the init
          // container, which has already finished by the time the task reports
          // RUNNING; re-running the same script here would mean a second fetch
          // of every repo on every start. This is the fallback for the case
          // where no init container could be added (a stack with no EFS, or an
          // env whose repos could not be planned), where it is still worth
          // trying and still deliberately non-fatal.
          if (!clonesInTask) await this.sandboxRepos.bootstrap(envId, log);

          await this.setStatus(envId, "running", { error: null });
          log(`[fargate] env is running\n`);
          return;
        }
        if (status === "STOPPED" || status === "DELETED") {
          const reason =
            task?.stoppedReason ||
            task?.containers?.map((c) => c.reason).filter(Boolean).join("; ") ||
            "task stopped before reaching RUNNING";
          throw new Error(reason);
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      throw new Error(
        `task did not reach RUNNING within ${Math.round(START_TIMEOUT_MS / 60000)} minutes`
      );
    } catch (err) {
      const msg =
        err instanceof ComposeTranslateError
          ? err.message
          : `Fargate start failed: ${this.errMsg(err)}`;
      // Never leave a route pointing at a task that failed to come up.
      await this.traefik.removeEnvRoutes(envId);
      await this.fail(envId, msg);
    }
  }

  private async stopBg(
    envId: string,
    opts: { silent?: boolean; purgeVolumes?: boolean } = {}
  ): Promise<void> {
    const log = (line: string) => this.logBuffer.push(envId, line);
    try {
      const env = await this.prisma.client.env.findUnique({
        where: { id: envId },
        select: { workspaceId: true, fargateTaskArn: true },
      });
      if (env?.fargateTaskArn) {
        const conn = await this.connections.getVerified(env.workspaceId);
        const { ecs } = this.clients(conn);
        log(`[fargate] stopping task ${env.fargateTaskArn.split("/").pop()}\n`);
        await ecs
          .send(
            new StopTaskCommand({
              cluster: conn.clusterArn!,
              task: env.fargateTaskArn,
              reason: "withvibe stop",
            })
          )
          .catch((err) => {
            // Already stopped / gone is fine.
            this.logger.warn(`[fargate] StopTask(${envId}): ${this.errMsg(err)}`);
          });
      }
      if (opts.purgeVolumes && env) {
        try {
          const conn = await this.connections.getVerified(env.workspaceId);
          const n = await this.efs.deleteForEnv(conn, envId);
          if (n > 0) log(`[fargate] removed ${n} persistent volume(s)\n`);
        } catch (err) {
          // Never let storage cleanup block a delete; the env row going away
          // matters more than a leftover directory.
          this.logger.warn(
            `[fargate] purge volumes for ${envId}: ${this.errMsg(err)}`
          );
        }
      }

      // Drop the Traefik route; serviceUrls stay (the hostnames are stable
      // and come back alive on the next start).
      await this.traefik.removeEnvRoutes(envId);
      await this.prisma.client.env.update({
        where: { id: envId },
        data: {
          fargateTaskArn: null,
          fargatePublicIp: null,
          fargateBridgeCert: null,
        },
      });
      if (!opts.silent) {
        await this.setStatus(envId, "stopped", { error: null });
        log(`[fargate] stopped\n`);
      }
    } catch (err) {
      await this.fail(envId, `stop failed: ${this.errMsg(err)}`);
    }
  }

  // ---------- observation ----------------------------------------------------

  async listEnvContainers(envId: string): Promise<EnvContainersResult> {
    try {
      const env = await this.prisma.client.env.findUnique({
        where: { id: envId },
        select: { workspaceId: true, fargateTaskArn: true },
      });
      if (!env?.fargateTaskArn) return { containers: [], serviceReady: false };
      const conn = await this.connections.getVerified(env.workspaceId);
      const task = await this.describeTask(conn, env.fargateTaskArn);
      if (!task) return { containers: [], serviceReady: false };
      const containers = (task.containers ?? []).map((c) => ({
        id: c.runtimeId ?? c.containerArn ?? "",
        name: c.name ?? "",
        service: c.name ?? "",
        status: `${c.lastStatus ?? "UNKNOWN"}${
          c.healthStatus && c.healthStatus !== "UNKNOWN"
            ? ` (${c.healthStatus.toLowerCase()})`
            : ""
        }`,
        image: c.image ?? "",
        health: this.mapHealth(c.healthStatus),
      }));
      const serviceReady =
        containers.length > 0 &&
        task.lastStatus === "RUNNING" &&
        !containers.some((c) => c.health === "starting");
      return { containers, serviceReady };
    } catch {
      return { containers: [], serviceReady: false };
    }
  }

  async getServiceLogs(
    envId: string,
    service: string,
    tail: number
  ): Promise<ServiceLogsResult> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, fargateTaskArn: true },
    });
    if (!env) {
      return { ok: false, error: "Environment not found", knownServices: [] };
    }
    try {
      const conn = await this.connections.getVerified(env.workspaceId);
      const { logs } = this.clients(conn);
      // awslogs stream: <prefix>/<container>/<taskId>. Find this service's
      // streams (newest first) — covers the current task and recent ones.
      const streams = await logs.send(
        new DescribeLogStreamsCommand({
          logGroupName: conn.logGroupName!,
          logStreamNamePrefix: `env/${service}/`,
          orderBy: "LogStreamName",
          descending: true,
          limit: 5,
        })
      );
      const candidates = streams.logStreams ?? [];
      if (candidates.length === 0) {
        const { containers } = await this.listEnvContainers(envId);
        return {
          ok: false,
          error: `No logs found for service "${service}"`,
          knownServices: containers.map((c) => c.service),
        };
      }
      // Prefer the stream of the CURRENT task when we know it.
      const taskId = env.fargateTaskArn?.split("/").pop();
      const stream =
        candidates.find((s) => taskId && s.logStreamName?.endsWith(taskId)) ??
        candidates
          .slice()
          .sort((a, b) => (b.lastEventTimestamp ?? 0) - (a.lastEventTimestamp ?? 0))[0];
      const events = await logs.send(
        new GetLogEventsCommand({
          logGroupName: conn.logGroupName!,
          logStreamName: stream.logStreamName!,
          limit: Math.min(tail, 5000),
          startFromHead: false,
        })
      );
      const text = (events.events ?? [])
        .map((e) => e.message ?? "")
        .join("\n");
      return {
        ok: true,
        text,
        service,
        containerIds: [stream.logStreamName ?? ""],
      };
    } catch (err) {
      return {
        ok: false,
        error: `Could not read CloudWatch logs: ${this.errMsg(err)}`,
        knownServices: [],
      };
    }
  }

  async streamRuntimeLogs(
    envId: string,
    onChunk: (text: string) => void
  ): Promise<LogStreamHandle | { error: string }> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, fargateTaskArn: true },
    });
    if (!env) return { error: "Environment not found" };
    let conn: AwsComputeConnection;
    try {
      conn = await this.connections.getVerified(env.workspaceId);
    } catch (err) {
      return { error: this.errMsg(err) };
    }
    const { logs } = this.clients(conn);
    const taskId = env.fargateTaskArn?.split("/").pop();
    // Poll FilterLogEvents across the whole group (stream prefix "env")
    // scoped to this task's streams, advancing a time cursor. CloudWatch has
    // no push tail; 3s polling is indistinguishable from `logs -f` in the UI.
    let since = Date.now() - 60_000;
    let closed = false;
    const tick = async () => {
      if (closed) return;
      try {
        const res = await logs.send(
          new FilterLogEventsCommand({
            logGroupName: conn.logGroupName!,
            startTime: since,
            ...(taskId
              ? { logStreamNames: await this.taskStreams(conn, taskId) }
              : {}),
          })
        );
        const events = res.events ?? [];
        if (events.length > 0) {
          since = Math.max(...events.map((e) => e.timestamp ?? since)) + 1;
          const text = events
            .map((e) => {
              const svc = e.logStreamName?.split("/")[1] ?? "?";
              return `${svc}  | ${e.message ?? ""}`;
            })
            .join("\n");
          onChunk(text + "\n");
        }
      } catch (err) {
        onChunk(`[fargate] log poll error: ${this.errMsg(err)}\n`);
      }
      if (!closed) timer = setTimeout(() => void tick(), 3_000);
    };
    let timer = setTimeout(() => void tick(), 0);
    return {
      close() {
        closed = true;
        clearTimeout(timer);
      },
    };
  }

  // ---------- interaction ----------------------------------------------------

  /**
   * Interactive shell via ECS ExecuteCommand: the session is brokered
   * through AWS's public SSM endpoints — no network path into the client VPC
   * is needed. The `session-manager-plugin` binary speaks the SSM session
   * protocol; we run it in a PTY (exactly how the AWS CLI does) and adapt it
   * to the ShellSession shape the terminal WebSocket expects.
   */
  async openShell(
    envId: string,
    containerKey: string,
    size: { cols: number; rows: number }
  ): Promise<ShellSession | null> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, fargateTaskArn: true },
    });
    if (!env?.fargateTaskArn) return null;
    const conn = await this.connections.getVerified(env.workspaceId);
    const task = await this.describeTask(conn, env.fargateTaskArn);
    if (!task || task.lastStatus !== "RUNNING") return null;
    const container = (task.containers ?? []).find(
      (c) =>
        c.name === containerKey ||
        c.runtimeId === containerKey ||
        (c.runtimeId ?? "").startsWith(containerKey)
    );
    if (!container?.name || container.lastStatus !== "RUNNING") return null;

    const { ecs } = this.clients(conn);
    const res = await ecs.send(
      new ExecuteCommandCommand({
        cluster: conn.clusterArn!,
        task: env.fargateTaskArn,
        container: container.name,
        interactive: true,
        command:
          "/bin/sh -c 'command -v bash >/dev/null && exec bash -l || exec sh -l'",
      })
    );
    const session = res.session;
    if (!session?.sessionId || !session.streamUrl || !session.tokenValue) {
      this.logger.error("[fargate] ExecuteCommand returned no session");
      return null;
    }

    const taskId = env.fargateTaskArn.split("/").pop();
    const clusterName = conn.clusterArn!.split("/").pop();
    let shell: pty.IPty;
    try {
      // Same five-arg invocation the AWS CLI uses. The binary ships with the
      // api image; dev hosts can point SESSION_MANAGER_PLUGIN_BIN anywhere.
      shell = pty.spawn(
        process.env.SESSION_MANAGER_PLUGIN_BIN || "session-manager-plugin",
        [
          JSON.stringify({
            SessionId: session.sessionId,
            StreamUrl: session.streamUrl,
            TokenValue: session.tokenValue,
          }),
          conn.region!,
          "StartSession",
          "",
          JSON.stringify({
            Target: `ecs:${clusterName}_${taskId}_${container.runtimeId}`,
          }),
          `https://ssm.${conn.region}.amazonaws.com`,
        ],
        {
          name: "xterm-256color",
          cols: size.cols,
          rows: size.rows,
          cwd: process.cwd(),
          env: process.env as { [key: string]: string },
        }
      );
    } catch (err) {
      this.logger.error(
        `[fargate] session-manager-plugin unavailable — install it on the api host ` +
          `(brew install --cask session-manager-plugin / see api Dockerfile): ${this.errMsg(err)}`
      );
      return null;
    }

    return {
      onData: (cb) => shell.onData(cb),
      onExit: (cb) => shell.onExit(cb),
      write: (data) => shell.write(data),
      resize: (cols, rows) => shell.resize(cols, rows),
      kill: () => shell.kill(),
    };
  }

  // ---------- helpers --------------------------------------------------------

  /**
   * Append the runner container (claude CLI + exec bridge) to the env's task
   * definition. Secrets policy: the Anthropic key and the bridge's TLS
   * private key travel ONLY via the task definition (TLS to the AWS API,
   * visible to the client account's admins — who own the sandbox anyway);
   * nothing secret ever crosses the bridge connection in cleartext because
   * the bridge itself is TLS with the generated cert.
   */
  /** Image every WithVibe-owned container in the task runs. */
  private runnerImage(): string {
    const namespace = process.env.WITHVIBE_IMAGE_NAMESPACE || "ghcr.io/withvibe";
    const tag =
      process.env.CLAUDE_RUNNER_FARGATE_TAG ||
      process.env.WITHVIBE_VERSION ||
      "latest";
    return `${namespace}/claude-runner:${tag}`;
  }

  /**
   * Add the container that materialises the env's repositories, and make the
   * services that mount them wait for it.
   *
   * The clone used to be driven from the platform once the task was up, which
   * put it strictly *after* every compose service had already started — fine
   * while nothing mounted the code, impossible once something does. As a
   * container it is part of the task's own startup, so ECS can order it.
   */
  private async addRepoInitContainer(
    envId: string,
    taskDef: import("@aws-sdk/client-ecs").RegisterTaskDefinitionCommandInput,
    requiredRepos: string[],
    servicesNeedingRepos: string[],
    log: (line: string) => void
  ): Promise<boolean> {
    const containers = taskDef.containerDefinitions ?? [];
    if (containers.some((c) => c.name === REPO_INIT_CONTAINER)) {
      throw new ComposeTranslateError(
        `"${REPO_INIT_CONTAINER}" is a reserved service name on Fargate envs`
      );
    }

    const planned = await this.sandboxRepos.plan(envId, requiredRepos);
    if (!planned.ok) {
      // With nothing mounting a repo this is survivable — the env comes up and
      // the reason is reported. With a mount it is not: fail now, while the
      // cause is still what gets shown.
      if (requiredRepos.length > 0) {
        throw new Error(
          `cannot set up the repositories this compose file mounts: ${
            planned.reason ?? "this env has no repositories attached"
          }`
        );
      }
      if (planned.reason) log(`[repos] skipped: ${planned.reason}\n`);
      return false;
    }

    containers.push({
      name: REPO_INIT_CONTAINER,
      image: this.runnerImage(),
      // Runs to completion. An essential container that exits takes the whole
      // task down with it, which is exactly what must not happen here.
      essential: false,
      command: ["sh", "-c", planned.script],
      environment: Object.entries(planned.env).map(([name, value]) => ({
        name,
        value,
      })),
      mountPoints: [
        { sourceVolume: WORKSPACE_VOLUME, containerPath: "/workspace" },
      ],
      logConfiguration: containers[0]?.logConfiguration,
    });

    for (const service of servicesNeedingRepos) {
      const container = containers.find((c) => c.name === service);
      if (!container) continue;
      container.dependsOn = [
        ...(container.dependsOn ?? []),
        // SUCCESS, not COMPLETE: a clone that failed leaves the directory this
        // service is about to mount empty, and the script exits non-zero
        // precisely so that this dependency stops the task here.
        { containerName: REPO_INIT_CONTAINER, condition: "SUCCESS" },
      ];
    }

    taskDef.containerDefinitions = containers;
    log(
      `[repos] clone runs in the task as "${REPO_INIT_CONTAINER}" ` +
        `(${planned.repoCount} repositor${planned.repoCount === 1 ? "y" : "ies"}, ` +
        `as ${planned.committer.name} <${planned.committer.email}>)\n`
    );
    if (servicesNeedingRepos.length > 0) {
      log(
        `[repos] ${servicesNeedingRepos.join(", ")} will not start until it succeeds\n`
      );
    }
    return true;
  }

  private async addRunnerContainer(
    envId: string,
    workspaceId: string,
    taskDef: import("@aws-sdk/client-ecs").RegisterTaskDefinitionCommandInput,
    log: (line: string) => void,
    fileSystemId: string | null,
    workspaceAccessPointId: string | null
  ): Promise<string> {
    const containers = taskDef.containerDefinitions ?? [];
    if (containers.some((c) => c.name === "withvibe-runner")) {
      throw new ComposeTranslateError(
        `"withvibe-runner" is a reserved service name on Fargate envs`
      );
    }
    const apiBase = fargateApiBaseUrl();
    if (!apiBase) {
      throw new Error(
        "Fargate envs need a publicly reachable api URL for the sandbox AI runner. " +
          "Set FARGATE_API_BASE_URL (or PUBLIC_API_BASE_URL / API_PUBLIC_URL) on the api."
      );
    }

    // Same key routing as the chat engines: workspace key wins, sk-ant-oat*
    // is an OAuth token. Resolved at task start; turns rely on container env.
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { anthropicApiKey: true },
    });
    const key =
      ws?.anthropicApiKey ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      "";
    const keyEnv: { name: string; value: string }[] = key
      ? [
          key.startsWith("sk-ant-oat")
            ? { name: "CLAUDE_CODE_OAUTH_TOKEN", value: key }
            : { name: "ANTHROPIC_API_KEY", value: key },
        ]
      : [];
    if (!key) {
      log(
        `[fargate] warning: no Anthropic API key configured — chat in this sandbox will fail until one is set\n`
      );
    }

    // Git in the sandbox authenticates against the proxy, never against
    // GitHub. Putting it in the container environment rather than in a repo's
    // config means the agent's own ad-hoc `git` commands are covered too, and
    // that nothing is left behind on the EFS volume when the task dies.
    // Attributed to the env's creator — the only identity that exists before
    // anyone has acted in the env.
    const creator = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { createdById: true },
    });
    const gitEnv = creator?.createdById
      ? this.gitProxy.gitConfigEnvFor(envId, creator.createdById)
      : {};
    if (!creator?.createdById) {
      log(
        `[fargate] note: this env has no recorded creator, so git inside the sandbox ` +
          `has no credential — repositories will not be cloned\n`
      );
    }

    const { cert, key: tlsKey } = await this.bridge.generateBridgeCert(envId);
    const image = this.runnerImage();

    containers.push({
      name: "withvibe-runner",
      image,
      essential: true,
      command: [
        "sh",
        "-c",
        // Fetch the bridge from the api (versions it with the api, no image
        // rebuilds) and run it. tini in the image reaps children.
        `curl -fsSL "$WV_BRIDGE_URL" -o /tmp/wv-bridge.js && exec node /tmp/wv-bridge.js`,
      ],
      environment: [
        { name: "WV_BRIDGE_URL", value: `${apiBase.replace(/\/$/, "")}/api/fargate/bridge.js` },
        { name: "WV_BRIDGE_PORT", value: String(FARGATE_BRIDGE_PORT) },
        { name: "WV_BRIDGE_TOKEN", value: this.bridge.bridgeToken(envId) },
        {
          name: "WV_BRIDGE_TLS_CERT_B64",
          value: Buffer.from(cert, "utf-8").toString("base64"),
        },
        {
          name: "WV_BRIDGE_TLS_KEY_B64",
          value: Buffer.from(tlsKey, "utf-8").toString("base64"),
        },
        // The container runs as root; IS_SANDBOX is Claude Code's documented
        // escape hatch so bypassPermissions works in containerized hosts.
        { name: "IS_SANDBOX", value: "1" },
        { name: "HOME", value: "/workspace/.withvibe/home" },
        { name: "GIT_TERMINAL_PROMPT", value: "0" },
        ...Object.entries(gitEnv).map(([name, value]) => ({ name, value })),
        ...keyEnv,
      ],
      portMappings: [{ containerPort: FARGATE_BRIDGE_PORT, protocol: "tcp" }],
      mountPoints: [
        { sourceVolume: WORKSPACE_VOLUME, containerPath: "/workspace" },
      ],
      // COMPLETE, not SUCCESS: the agent should open on a finished workspace,
      // but a repository that would not clone is a thing to come in and
      // diagnose — so the runner comes up either way.
      ...(containers.some((c) => c.name === REPO_INIT_CONTAINER)
        ? {
            dependsOn: [
              { containerName: REPO_INIT_CONTAINER, condition: "COMPLETE" as const },
            ],
          }
        : {}),
      healthCheck: {
        command: [
          "CMD-SHELL",
          `curl -skf https://127.0.0.1:${FARGATE_BRIDGE_PORT}/healthz || exit 1`,
        ],
        interval: 15,
        timeout: 5,
        retries: 3,
        startPeriod: 60,
      },
      logConfiguration: containers[0]?.logConfiguration,
    });
    taskDef.containerDefinitions = containers;
    taskDef.volumes = [
      ...(taskDef.volumes ?? []),
      workspaceAccessPointId && fileSystemId
        ? {
            name: WORKSPACE_VOLUME,
            efsVolumeConfiguration: {
              fileSystemId,
              transitEncryption: "ENABLED" as const,
              authorizationConfig: {
                accessPointId: workspaceAccessPointId,
                iam: "ENABLED" as const,
              },
            },
          }
        : { name: WORKSPACE_VOLUME },
    ];
    log(`[fargate] runner container added (${image})\n`);
    return cert;
  }

  private clients(conn: AwsComputeConnection) {
    return this.aws.clientsFor({
      roleArn: conn.roleArn!,
      externalId: conn.externalId,
      region: conn.region!,
    });
  }

  private family(envId: string): string {
    // Task definition family: letters, numbers, hyphens, underscores; ≤255.
    return `withvibe-${envId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 255);
  }

  private startedBy(envId: string): string {
    // startedBy is capped at 36 chars; cuids fit with the prefix trimmed.
    return `wv-${envId}`.slice(0, 36);
  }

  private async describeTask(
    conn: AwsComputeConnection,
    taskArn: string
  ): Promise<Task | null> {
    const { ecs } = this.clients(conn);
    const res = await ecs.send(
      new DescribeTasksCommand({ cluster: conn.clusterArn!, tasks: [taskArn] })
    );
    return res.tasks?.[0] ?? null;
  }

  /** The task ENI's public IP — what Traefik proxies to in Phase 2. */
  private async resolvePublicIp(
    conn: AwsComputeConnection,
    task: Task
  ): Promise<string | null> {
    const eniId = task.attachments
      ?.find((a) => a.type === "ElasticNetworkInterface")
      ?.details?.find((d) => d.name === "networkInterfaceId")?.value;
    if (!eniId) return null;
    try {
      const { ec2 } = this.clients(conn);
      const res = await ec2.send(
        new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [eniId] })
      );
      return res.NetworkInterfaces?.[0]?.Association?.PublicIp ?? null;
    } catch (err) {
      this.logger.warn(`[fargate] public IP lookup failed: ${this.errMsg(err)}`);
      return null;
    }
  }

  private async taskStreams(
    conn: AwsComputeConnection,
    taskId: string
  ): Promise<string[]> {
    const { logs } = this.clients(conn);
    const res = await logs.send(
      new DescribeLogStreamsCommand({
        logGroupName: conn.logGroupName!,
        logStreamNamePrefix: "env/",
        limit: 50,
      })
    );
    const names = (res.logStreams ?? [])
      .map((s) => s.logStreamName ?? "")
      .filter((n) => n.endsWith(`/${taskId}`));
    // FilterLogEvents rejects an empty stream list — fall back to the prefix.
    return names.length > 0 ? names : [`env/`];
  }

  private mapHealth(
    h: string | undefined
  ): "healthy" | "starting" | "unhealthy" | "none" {
    if (h === "HEALTHY") return "healthy";
    if (h === "UNHEALTHY") return "unhealthy";
    // ECS reports UNKNOWN both for "no healthcheck" and "still starting";
    // container-level nuance arrives with task lastStatus, so map to none.
    return "none";
  }

  private async setStatus(
    envId: string,
    status: string,
    extra: { error?: string | null } = {}
  ): Promise<void> {
    await this.prisma.client.env.update({
      where: { id: envId },
      data: {
        containerStatus: status,
        lastContainerAt: new Date(),
        ...(extra.error !== undefined && { containerError: extra.error }),
      },
    });
  }

  private async fail(envId: string, message: string): Promise<void> {
    this.logger.error(`[fargate] env ${envId}: ${message}`);
    this.logBuffer.push(envId, `[fargate] ERROR: ${message}\n`);
    await this.setStatus(envId, "error", { error: message });
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private async readDotEnv(envDir: string): Promise<Record<string, string>> {
    try {
      const raw = await readFile(path.join(envDir, ".env"), "utf-8");
      const out: Record<string, string> = {};
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const idx = t.indexOf("=");
        if (idx === -1) continue;
        const key = t.slice(0, idx).trim();
        let val = t.slice(idx + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        out[key] = val;
      }
      return out;
    } catch {
      return {};
    }
  }
}
