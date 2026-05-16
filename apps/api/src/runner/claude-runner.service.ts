import { Injectable, Logger } from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import { ensureEnvDir } from "../common/repo-base-dir";
import { EnvCloneService } from "../env-clones/env-clone.service";
import { composeProjectName } from "../docker/compose-naming";

const exec = promisify(execFile);

// Tag follows the install's WITHVIBE_VERSION (set by `withvibe init` from
// the bundle's bundle.json). Falls back to :latest for from-source installs.
const RUNNER_IMAGE =
  process.env.CLAUDE_RUNNER_IMAGE ||
  `withvibe-claude-runner:${process.env.WITHVIBE_VERSION || "latest"}`;

export type RunnerStatus =
  | { state: "missing"; imagePresent: boolean }
  | { state: "created" | "running" | "exited"; containerId: string; imagePresent: boolean };

/**
 * Per-env sidecar that hosts the real `claude` CLI. Bind-mounts the env
 * clone at /workspace and joins the env's compose network (best-effort —
 * if user hasn't started compose yet the runner still works, just without
 * access to user services).
 *
 * Lazy lifecycle: Phase 4's ClaudeCodeEngineService calls `ensureRunning`
 * on the first `claude_code` chat turn; if it fails we auto-fall back to
 * Agent SDK and the runner keeps coming up in the background.
 *
 * Idempotent — ensureRunning is safe to call on every turn.
 */
@Injectable()
export class ClaudeRunnerService {
  private readonly logger = new Logger(ClaudeRunnerService.name);

  constructor(private readonly envClones: EnvCloneService) {}

  /** `claude-runner-<envId>` — stable, one per env, collision-free. */
  containerName(envId: string): string {
    return `claude-runner-${envId}`;
  }

  /** Best-effort: returns null if the user hasn't started compose yet. */
  async composeNetworkName(envId: string): Promise<string | null> {
    const project = composeProjectName(envId);
    try {
      const { stdout } = await exec(
        "docker",
        [
          "network",
          "ls",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          "{{.Name}}",
        ],
        { timeout: 5_000 }
      );
      const first = stdout.trim().split("\n").find((n) => n.trim().length > 0);
      return first ?? null;
    } catch {
      return null;
    }
  }

  async isImagePresent(): Promise<boolean> {
    try {
      const { stdout } = await exec(
        "docker",
        ["image", "inspect", RUNNER_IMAGE, "--format", "{{.Id}}"],
        { timeout: 5_000 }
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async status(envId: string): Promise<RunnerStatus> {
    const imagePresent = await this.isImagePresent();
    try {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `name=^${this.containerName(envId)}$`,
          "--format",
          "{{.ID}}\t{{.State}}",
        ],
        { timeout: 5_000 }
      );
      const line = stdout.trim().split("\n").find((l) => l.trim().length > 0);
      if (!line) return { state: "missing", imagePresent };
      const [containerId, state] = line.split("\t");
      if (state === "running") {
        return { state: "running", containerId, imagePresent };
      }
      if (state === "created") {
        return { state: "created", containerId, imagePresent };
      }
      return { state: "exited", containerId, imagePresent };
    } catch {
      return { state: "missing", imagePresent };
    }
  }

  /**
   * Ensure a healthy runner is up for this env. Idempotent.
   * Returns the container name on success. Throws on failure (Phase 4 catches
   * and auto-falls-back to Agent SDK for the turn).
   */
  async ensureRunning(envId: string, workspaceId: string): Promise<string> {
    const name = this.containerName(envId);

    if (!(await this.isImagePresent())) {
      throw new Error(
        `Runner image ${RUNNER_IMAGE} not present. Build it with: docker build -t ${RUNNER_IMAGE} apps/api/runner`
      );
    }

    const current = await this.status(envId);
    if (current.state === "running") {
      return name;
    }

    // If there's a stopped/created container, remove it first — bind mounts
    // or network membership may be stale (e.g. user tore down compose).
    if (current.state === "exited" || current.state === "created") {
      await exec("docker", ["rm", "-f", name], { timeout: 10_000 }).catch(
        () => undefined
      );
    }

    const envDir = this.envClones.envDir(workspaceId, envId);
    await ensureEnvDir(envDir);

    const network = await this.composeNetworkName(envId);
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `withvibe.runner=true`,
      "--label",
      `withvibe.envId=${envId}`,
      "-v",
      `${envDir}:/workspace`,
      "--add-host",
      "host.docker.internal:host-gateway",
    ];
    if (network) {
      args.push("--network", network);
    }
    args.push(RUNNER_IMAGE);

    this.logger.log(
      `[runner] starting container ${name} (network=${network ?? "none"}, mount=${envDir})`
    );
    try {
      await exec("docker", args, { timeout: 30_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to start runner: ${msg}`);
    }

    // Health check — claude --version must succeed.
    try {
      await exec("docker", ["exec", name, "claude", "--version"], {
        timeout: 10_000,
      });
    } catch (err) {
      await exec("docker", ["rm", "-f", name], { timeout: 10_000 }).catch(
        () => undefined
      );
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Runner started but health check failed: ${msg}`);
    }

    return name;
  }

  async stop(envId: string): Promise<void> {
    const name = this.containerName(envId);
    await exec("docker", ["rm", "-f", name], { timeout: 15_000 }).catch(
      () => undefined
    );
  }

  /** Bind the runner to the (now-existing) compose network if it wasn't there. */
  async reattachToComposeNetwork(envId: string): Promise<void> {
    const current = await this.status(envId);
    if (current.state !== "running") return;
    const network = await this.composeNetworkName(envId);
    if (!network) return;
    const name = this.containerName(envId);
    // Idempotent — `network connect` errors if already connected; ignore.
    await exec("docker", ["network", "connect", network, name], {
      timeout: 10_000,
    }).catch(() => undefined);
  }

  // Read-only wrapper for the UI status badge (Phase 3) and the fallback
  // banner (Phase 4). Covers the three states the banner cares about:
  //   - "running" → claude_code path is healthy
  //   - "missing" / "exited" / "created" → need to ensureRunning
  //   - "image_missing" → build the image (banner link to docs)
  async uiStatus(envId: string): Promise<
    "running" | "stopped" | "image_missing"
  > {
    const s = await this.status(envId);
    if (!s.imagePresent) return "image_missing";
    if (s.state === "running") return "running";
    return "stopped";
  }
}
