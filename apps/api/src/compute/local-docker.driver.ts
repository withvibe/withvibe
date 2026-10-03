import { Injectable } from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import * as pty from "node-pty";
import { DockerService } from "../docker/docker.service";
import type {
  EnvComputeDriver,
  EnvContainersResult,
  LogStreamHandle,
  ServiceLifecycleAction,
  ServiceLogsResult,
  ShellSession,
} from "./env-compute-driver";

const exec = promisify(execFile);

/**
 * The `local` compute target: env containers run on the host Docker daemon
 * the api drives via DooD — the only behavior that existed before compute
 * targets. Lifecycle is a thin delegation to DockerService (which keeps all
 * compose mechanics); this class owns the two interaction shapes the seam
 * abstracts — the follow-log stream and the interactive shell.
 */
@Injectable()
export class LocalDockerDriver implements EnvComputeDriver {
  readonly target = "local" as const;

  constructor(private readonly docker: DockerService) {}

  startEnvironment(envId: string): Promise<void> {
    return this.docker.startEnvironment(envId);
  }

  stopEnvironment(
    envId: string,
    options: { purgeVolumes?: boolean } = {}
  ): Promise<void> {
    return this.docker.stopEnvironment(envId, options);
  }

  rebuildEnvironment(envId: string): Promise<void> {
    return this.docker.rebuildEnvironment(envId);
  }

  serviceAction(
    envId: string,
    service: string,
    action: ServiceLifecycleAction
  ): Promise<void> {
    return this.docker.serviceAction(envId, service, action);
  }

  listEnvContainers(envId: string): Promise<EnvContainersResult> {
    return this.docker.listEnvContainers(envId);
  }

  getServiceLogs(
    envId: string,
    service: string,
    tail: number
  ): Promise<ServiceLogsResult> {
    return this.docker.getServiceLogs(envId, service, tail);
  }

  async streamRuntimeLogs(
    envId: string,
    onChunk: (text: string) => void
  ): Promise<LogStreamHandle | { error: string }> {
    const spawned = await this.docker.spawnLogProcess(envId);
    if ("error" in spawned) return { error: spawned.error };
    const child = spawned.child;
    const onData = (buf: Buffer) => onChunk(buf.toString("utf-8"));
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => {});
    return {
      close() {
        try {
          child.kill("SIGTERM");
        } catch {}
      },
    };
  }

  async openShell(
    envId: string,
    containerKey: string,
    size: { cols: number; rows: number }
  ): Promise<ShellSession | null> {
    const project = this.docker.composeProjectName(envId);
    const containerId = await this.resolveContainer(project, containerKey);
    if (!containerId) return null;

    const shell = pty.spawn(
      "docker",
      [
        "exec",
        "-it",
        containerId,
        "sh",
        "-c",
        "command -v bash >/dev/null && exec bash -l || exec sh -l",
      ],
      {
        name: "xterm-256color",
        cols: size.cols,
        rows: size.rows,
        cwd: process.cwd(),
        env: process.env as { [key: string]: string },
      }
    );

    return {
      onData: (cb) => shell.onData(cb),
      onExit: (cb) => shell.onExit(cb),
      write: (data) => shell.write(data),
      resize: (cols, rows) => shell.resize(cols, rows),
      kill: () => shell.kill(),
    };
  }

  /**
   * Resolve a container id/prefix/name to a running container id, scoped to
   * this env's compose project so a shell can never be opened into another
   * env's container.
   */
  private async resolveContainer(
    project: string,
    key: string
  ): Promise<string | null> {
    try {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          "{{.ID}}\t{{.Names}}",
        ],
        { timeout: 10_000 }
      );
      const candidates = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, name] = line.split("\t");
          return { id, name };
        });
      const match = candidates.find(
        (c) => c.id === key || c.id.startsWith(key) || c.name === key
      );
      return match ? match.id : null;
    } catch {
      return null;
    }
  }
}
