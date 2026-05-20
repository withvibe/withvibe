import { Injectable } from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import { PrismaService } from "../prisma/prisma.service";
import { composeProjectName } from "./compose-naming";
import type { DetectedDatabase } from "./database-detection";
import { attachToWithvibe, resolveSidecarTarget } from "./sidecar-net";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

const exec = promisify(execFile);

// Adminer listens on 8080 inside the container. We publish to a random host
// port on loopback so it's only reachable from the same machine that runs
// the API (matches the existing env web-preview contract).
const ADMINER_IMAGE = "adminer:latest";
const ADMINER_INTERNAL_PORT = 8080;

type StartResult =
  | { ok: true; containerId: string; port: number }
  | { ok: false; error: string };

@Injectable()
export class DbViewerService {
  constructor(
    @InjectPinoLogger(DbViewerService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService
  ) {}

  async start(envId: string): Promise<StartResult> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        id: true,
        containerStatus: true,
        detectedDatabases: true,
        dbViewerContainerId: true,
        dbViewerPort: true,
        dbViewerStatus: true,
      },
    });
    if (!env) return { ok: false, error: "Env not found" };

    if (env.containerStatus !== "running") {
      return {
        ok: false,
        error: "Env must be running before starting the DB viewer.",
      };
    }

    const dbs = Array.isArray(env.detectedDatabases)
      ? (env.detectedDatabases as unknown as DetectedDatabase[])
      : [];
    if (dbs.length === 0) {
      return {
        ok: false,
        error:
          "No databases detected in this env's compose file — nothing to view.",
      };
    }

    // If a previous viewer is still running, reuse it. If it was recorded but
    // the container is gone (crash, manual cleanup, host reboot), wipe state
    // and start fresh.
    if (env.dbViewerContainerId) {
      const alive = await this.containerAlive(env.dbViewerContainerId);
      if (alive && env.dbViewerPort) {
        return {
          ok: true,
          containerId: env.dbViewerContainerId,
          port: env.dbViewerPort,
        };
      }
      await this.hardStop(env.dbViewerContainerId).catch(() => {});
    }

    const project = composeProjectName(envId);
    const network = await this.findEnvNetwork(project);
    if (!network) {
      return {
        ok: false,
        error: `Could not find the env's compose network (project=${project}). Start the env first so docker-compose creates its network.`,
      };
    }

    await this.prisma.client.env.update({
      where: { id: envId },
      data: {
        dbViewerStatus: "starting",
        dbViewerError: null,
      },
    });

    try {
      const { stdout: cidRaw } = await exec(
        "docker",
        [
          "run",
          "--rm",
          "-d",
          "--network",
          network,
          "--label",
          `com.withvibe.db-viewer=${envId}`,
          "-e",
          `ADMINER_DEFAULT_SERVER=${dbs[0].service}`,
          "-p",
          `127.0.0.1:0:${ADMINER_INTERNAL_PORT}`,
          ADMINER_IMAGE,
        ],
        { timeout: 30_000 }
      );
      const containerId = cidRaw.trim();
      if (!containerId) throw new Error("docker run returned empty container id");

      // Join the shared `withvibe` network so a containerized api can reach
      // Adminer by IP (published port is loopback-only — see sidecar-net.ts).
      await attachToWithvibe(containerId);

      const port = await this.resolvePublishedPort(containerId);
      if (!port) {
        await this.hardStop(containerId).catch(() => {});
        throw new Error("Failed to resolve Adminer's published port");
      }

      await this.prisma.client.env.update({
        where: { id: envId },
        data: {
          dbViewerContainerId: containerId,
          dbViewerPort: port,
          dbViewerStatus: "running",
          dbViewerError: null,
        },
      });

      this.logger.info(
        `Env ${envId}: started Adminer viewer container ${containerId.slice(0, 12)} on 127.0.0.1:${port}`
      );
      return { ok: true, containerId, port };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.client.env.update({
        where: { id: envId },
        data: {
          dbViewerContainerId: null,
          dbViewerPort: null,
          dbViewerStatus: "error",
          dbViewerError: msg,
        },
      });
      return { ok: false, error: msg };
    }
  }

  async stop(envId: string): Promise<{ ok: true }> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { dbViewerContainerId: true },
    });
    if (env?.dbViewerContainerId) {
      await this.hardStop(env.dbViewerContainerId).catch((err) => {
        this.logger.warn(
          `Env ${envId}: failed to remove viewer container ${env.dbViewerContainerId}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
    await this.prisma.client.env.update({
      where: { id: envId },
      data: {
        dbViewerContainerId: null,
        dbViewerPort: null,
        dbViewerStatus: "stopped",
        dbViewerError: null,
      },
    });
    return { ok: true };
  }

  // Called on env stop/rebuild — best-effort cleanup, never throws.
  async stopQuiet(envId: string): Promise<void> {
    await this.stop(envId).catch(() => {});
  }

  /** `host:port` the api can reach the running Adminer at. See sidecar-net.ts. */
  async getProxyTarget(envId: string): Promise<string | null> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        dbViewerContainerId: true,
        dbViewerPort: true,
        dbViewerStatus: true,
      },
    });
    return resolveSidecarTarget({
      containerId: env?.dbViewerContainerId,
      status: env?.dbViewerStatus,
      publishedPort: env?.dbViewerPort,
      internalPort: ADMINER_INTERNAL_PORT,
    });
  }

  /**
   * Same-origin proxied path the browser uses. Always relative: Adminer is
   * plain HTTP (no WebSocket), so it routes fine through Next's dev rewrite
   * locally and through the Traefik path-prefix router in production —
   * unlike code-server, which needs WS and so keeps a dev-host shortcut.
   * Null when not running.
   */
  async viewerUrl(envId: string): Promise<string | null> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { dbViewerStatus: true },
    });
    return env?.dbViewerStatus === "running"
      ? `/api/db-viewer/view/${envId}/`
      : null;
  }

  private async findEnvNetwork(project: string): Promise<string | null> {
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
        { timeout: 10_000 }
      );
      const names = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) return null;
      // Prefer the project's "default" network if present (most composes use it).
      const preferred = names.find((n) => n.endsWith("_default"));
      return preferred || names[0];
    } catch {
      return null;
    }
  }

  private async resolvePublishedPort(containerId: string): Promise<number | null> {
    // `docker port <cid> 8080` → "127.0.0.1:54321\n" (possibly multiple lines if bound to 0.0.0.0 + ::).
    try {
      const { stdout } = await exec(
        "docker",
        ["port", containerId, String(ADMINER_INTERNAL_PORT)],
        { timeout: 10_000 }
      );
      for (const line of stdout.split("\n")) {
        const match = line.match(/:(\d+)$/);
        if (match) return Number(match[1]);
      }
      return null;
    } catch {
      return null;
    }
  }

  private async containerAlive(containerId: string): Promise<boolean> {
    try {
      const { stdout } = await exec(
        "docker",
        ["inspect", "-f", "{{.State.Running}}", containerId],
        { timeout: 5_000 }
      );
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async hardStop(containerId: string): Promise<void> {
    // --rm was set at run time, so stop triggers removal. Use rm -f as a
    // safety net in case the container is in a weird state.
    await exec("docker", ["rm", "-f", containerId], { timeout: 30_000 });
  }
}
