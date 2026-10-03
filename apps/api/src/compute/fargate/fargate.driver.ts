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
    private readonly bridge: FargateExecService
  ) {}

  // ---------- lifecycle ------------------------------------------------------

  async startEnvironment(envId: string): Promise<void> {
    await this.setStatus(envId, "starting", { error: null });
    void this.startBg(envId);
  }

  async stopEnvironment(
    envId: string,
    // purgeVolumes is meaningless here: task volumes are ephemeral and die
    // with the task, so a fargate stop always "purges".
    _options: { purgeVolumes?: boolean } = {}
  ): Promise<void> {
    await this.setStatus(envId, "stopping", { error: null });
    void this.stopBg(envId);
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
      const translated = translateComposeToTaskDef({
        composeYaml,
        dotEnv,
        family: this.family(envId),
        logGroupName: conn.logGroupName!,
        region: conn.region!,
        executionRoleArn: conn.taskExecutionRoleArn!,
        taskRoleArn: conn.taskRoleArn!,
      });
      for (const note of translated.notes) log(`[fargate] note: ${note}\n`);

      // The sandbox AI: a runner container (claude CLI) rides in every
      // fargate task, serving the exec bridge the chat engine drives. The
      // bridge is fetched from the api at boot, so the task must be able to
      // reach the api on a public URL.
      const bridgeCert = await this.addRunnerContainer(
        envId,
        env.workspaceId,
        translated.taskDefinition,
        log
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
          tags: [{ key: "withvibe-env", value: envId }],
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
    opts: { silent?: boolean } = {}
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
  private async addRunnerContainer(
    envId: string,
    workspaceId: string,
    taskDef: import("@aws-sdk/client-ecs").RegisterTaskDefinitionCommandInput,
    log: (line: string) => void
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

    const { cert, key: tlsKey } = await this.bridge.generateBridgeCert(envId);
    const image = `${process.env.WITHVIBE_IMAGE_NAMESPACE || "ghcr.io/withvibe"}/claude-runner:${
      process.env.CLAUDE_RUNNER_FARGATE_TAG ||
      process.env.WITHVIBE_VERSION ||
      "latest"
    }`;

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
        ...keyEnv,
      ],
      portMappings: [{ containerPort: FARGATE_BRIDGE_PORT, protocol: "tcp" }],
      mountPoints: [
        { sourceVolume: "withvibe-workspace", containerPath: "/workspace" },
      ],
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
      { name: "withvibe-workspace" },
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
