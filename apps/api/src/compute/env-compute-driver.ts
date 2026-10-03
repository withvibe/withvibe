import type { ComputeTarget } from "@withvibe/db";

/**
 * The compute-driver seam. Everything the platform needs from "the place an
 * env's containers run", expressed without Docker vocabulary so a remote
 * driver (Fargate) can implement the same contract:
 *
 *   - lifecycle: start / stop / rebuild the whole env, per-service actions
 *   - observation: container list + health, per-service runtime logs,
 *     a follow-stream of runtime output
 *   - interaction: an interactive shell into one of the env's containers
 *
 * What deliberately stays OUT of the interface:
 *   - the lifecycle log buffer (EnvLogBufferService) — target-agnostic,
 *     drivers write into it, readers never touch a driver
 *   - compose parsing / rewriting — that's input materialization, upstream
 *     of any driver
 *   - sidecars (QA browser, db-viewer, code-server) — they get their own
 *     seam when the Fargate phases reach them
 */

export type EnvContainerInfo = {
  id: string;
  name: string;
  /** Compose service name (or ECS container name) — the per-service action key. */
  service: string;
  /** Human-readable runtime status line ("Up 2 minutes (healthy)"). */
  status: string;
  image: string;
  health: "healthy" | "starting" | "unhealthy" | "none";
};

export type EnvContainersResult = {
  containers: EnvContainerInfo[];
  /** True once every running container is past its healthcheck (or has none). */
  serviceReady: boolean;
};

export type ServiceLogsResult =
  | { ok: true; text: string; service: string; containerIds: string[] }
  | { ok: false; error: string; knownServices: string[] };

/** Handle for a live runtime-log follow stream. */
export type LogStreamHandle = { close(): void };

export type ServiceLifecycleAction = "start" | "stop" | "restart" | "rebuild";

/**
 * An interactive shell session inside one of the env's containers.
 * Locally this wraps `docker exec -it` in a PTY; on Fargate it wraps an
 * ECS ExecuteCommand (SSM) session. Shape mirrors node-pty's IPty so the
 * local driver is a thin adapter.
 */
export interface ShellSession {
  onData(cb: (data: string) => void): void;
  onExit(
    cb: (info: { exitCode: number; signal?: number | string | null }) => void
  ): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface EnvComputeDriver {
  readonly target: ComputeTarget;

  /** Fire-and-forget: sets env status and provisions in the background. */
  startEnvironment(envId: string): Promise<void>;

  /**
   * `purgeVolumes` is for env DELETION only — a plain stop must leave the
   * env's data volumes alone.
   */
  stopEnvironment(
    envId: string,
    options?: { purgeVolumes?: boolean }
  ): Promise<void>;

  rebuildEnvironment(envId: string): Promise<void>;

  /** Per-service lifecycle; must not touch the env-level containerStatus. */
  serviceAction(
    envId: string,
    service: string,
    action: ServiceLifecycleAction
  ): Promise<void>;

  listEnvContainers(envId: string): Promise<EnvContainersResult>;

  /** Runtime stdout/stderr tail of a single service (running or crashed). */
  getServiceLogs(
    envId: string,
    service: string,
    tail: number
  ): Promise<ServiceLogsResult>;

  /**
   * Follow the env's combined runtime output (compose logs -f / CloudWatch
   * tail), delivering chunks until closed. Lifecycle/build output is NOT
   * delivered here — that comes from EnvLogBufferService.
   */
  streamRuntimeLogs(
    envId: string,
    onChunk: (text: string) => void
  ): Promise<LogStreamHandle | { error: string }>;

  /**
   * Open an interactive shell in the container identified by `containerKey`
   * (id, id prefix, or name — driver-resolved within this env only).
   * Returns null when the container isn't running in this env.
   */
  openShell(
    envId: string,
    containerKey: string,
    size: { cols: number; rows: number }
  ): Promise<ShellSession | null>;
}
