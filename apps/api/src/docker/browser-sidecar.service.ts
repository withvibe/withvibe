import { Injectable } from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import { PrismaService } from "../prisma/prisma.service";
import { composeProjectName } from "./compose-naming";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

const exec = promisify(execFile);

// Tiny purpose-built image: chromium + Xvfb + x11vnc + noVNC. Defined in
// `apps/api/qa-browser-image/`. Build it once with:
//   docker build -t withvibe-qa-browser apps/api/qa-browser-image
// Override with QA_BROWSER_IMAGE if you want to pin a registry-hosted tag.
// Tag follows the install's WITHVIBE_VERSION (set by `withvibe init`); falls
// back to :latest for from-source installs.
const DEFAULT_IMAGE = `withvibe-qa-browser:${process.env.WITHVIBE_VERSION || "latest"}`;
const VNC_INTERNAL_PORT = 7900;
const CDP_INTERNAL_PORT = 9222;

type StartResult =
  | { ok: true; containerId: string; cdpPort: number; vncPort: number }
  | { ok: false; error: string };

@Injectable()
export class BrowserSidecarService {
  constructor(
    @InjectPinoLogger(BrowserSidecarService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService
  ) {}

  private image(): string {
    return process.env.QA_BROWSER_IMAGE?.trim() || DEFAULT_IMAGE;
  }

  /**
   * Read-only accessor for the chat pipeline — returns the live CDP endpoint
   * Playwright should connect to (HTTP form: Playwright's `connectOverCDP`
   * resolves /json/version → ws URL automatically), or null if no sidecar is
   * running.
   */
  async getCdpEndpoint(envId: string): Promise<string | null> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        qaBrowserContainerId: true,
        qaBrowserCdpPort: true,
        qaBrowserStatus: true,
      },
    });
    if (
      !env?.qaBrowserContainerId ||
      !env.qaBrowserCdpPort ||
      env.qaBrowserStatus !== "running"
    ) {
      return null;
    }
    if (!(await this.containerAlive(env.qaBrowserContainerId))) {
      await this.prisma.client.env.update({
        where: { id: envId },
        data: {
          qaBrowserContainerId: null,
          qaBrowserCdpPort: null,
          qaBrowserVncPort: null,
          qaBrowserStatus: "stopped",
          qaBrowserError: null,
        },
      });
      return null;
    }
    // Inside the api container we connect via the qa-browser's IP on the
    // shared `withvibe` network — Chrome's CDP rejects Host headers that
    // aren't an IP/localhost, so going through host.docker.internal hits
    // a DNS-rebinding guard. On dev installs (api on host), 127.0.0.1 +
    // the published port is the right path.
    const inContainer = await this.fileExists("/.dockerenv");
    if (inContainer) {
      const ip = await this.containerIpOnWithvibe(env.qaBrowserContainerId);
      if (ip) return `http://${ip}:${CDP_INTERNAL_PORT}`;
      this.logger.warn(
        "QA browser not on withvibe network — falling back to host loopback (Chrome may reject)."
      );
    }
    return `http://127.0.0.1:${env.qaBrowserCdpPort}`;
  }

  /**
   * Resolve a `host:port` the api process can reach the sidecar's noVNC
   * (websockify on :7900) at — used by the HTTP asset proxy and the
   * `QaViewGateway` WS relay. Same in-container vs on-host logic as
   * `getCdpEndpoint`: a deployed api (in a container) talks to the sidecar
   * by its IP on the shared `withvibe` network and the *internal* 7900;
   * a dev api (on the host) uses 127.0.0.1 + the published VNC port.
   * Returns null when no sidecar is running for the env.
   */
  async getNoVncTarget(envId: string): Promise<string | null> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        qaBrowserContainerId: true,
        qaBrowserVncPort: true,
        qaBrowserStatus: true,
      },
    });
    if (
      !env?.qaBrowserContainerId ||
      !env.qaBrowserVncPort ||
      env.qaBrowserStatus !== "running"
    ) {
      return null;
    }
    if (!(await this.containerAlive(env.qaBrowserContainerId))) {
      return null;
    }
    const inContainer = await this.fileExists("/.dockerenv");
    if (inContainer) {
      const ip = await this.containerIpOnWithvibe(env.qaBrowserContainerId);
      if (ip) return `${ip}:${VNC_INTERNAL_PORT}`;
      this.logger.warn(
        "QA browser not on withvibe network — falling back to host loopback for noVNC."
      );
    }
    return `127.0.0.1:${env.qaBrowserVncPort}`;
  }

  private async containerIpOnWithvibe(
    containerId: string
  ): Promise<string | null> {
    try {
      const { stdout } = await exec("docker", [
        "inspect",
        "-f",
        "{{.NetworkSettings.Networks.withvibe.IPAddress}}",
        containerId,
      ]);
      const ip = stdout.trim();
      return ip && ip !== "<no value>" ? ip : null;
    } catch {
      return null;
    }
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      const fs = await import("node:fs/promises");
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async start(envId: string): Promise<StartResult> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        id: true,
        containerStatus: true,
        qaBrowserContainerId: true,
        qaBrowserCdpPort: true,
        qaBrowserVncPort: true,
        qaBrowserStatus: true,
      },
    });
    if (!env) return { ok: false, error: "Env not found" };

    if (env.containerStatus !== "running") {
      return {
        ok: false,
        error:
          "Env must be running before starting the QA browser — start the env first.",
      };
    }

    if (
      env.qaBrowserContainerId &&
      env.qaBrowserCdpPort &&
      env.qaBrowserVncPort
    ) {
      const alive = await this.containerAlive(env.qaBrowserContainerId);
      if (alive) {
        return {
          ok: true,
          containerId: env.qaBrowserContainerId,
          cdpPort: env.qaBrowserCdpPort,
          vncPort: env.qaBrowserVncPort,
        };
      }
      await this.hardStop(env.qaBrowserContainerId).catch(() => {});
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
        qaBrowserStatus: "starting",
        qaBrowserError: null,
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
          `com.withvibe.qa-browser=${envId}`,
          // host.docker.internal isn't auto-resolved on Linux; on Docker
          // Desktop (mac/Windows) the explicit mapping is a harmless no-op.
          // The chromium entrypoint relies on this name to map `localhost`
          // back to the host so React bundles baked with PUBLIC_HOST=localhost
          // can still reach published env ports from inside the QA browser.
          "--add-host",
          "host.docker.internal:host-gateway",
          // Chromium hard-fails on the default 64MB /dev/shm.
          "--shm-size",
          "2g",
          // The image launches chromium with --no-sandbox; it still needs a
          // permissive seccomp profile to satisfy a few syscalls Chrome makes
          // during early init.
          "--security-opt",
          "seccomp=unconfined",
          "-p",
          `127.0.0.1:0:${VNC_INTERNAL_PORT}`,
          "-p",
          `127.0.0.1:0:${CDP_INTERNAL_PORT}`,
          this.image(),
        ],
        { timeout: 120_000 }
      );
      const containerId = cidRaw.trim();
      if (!containerId)
        throw new Error("docker run returned empty container id");

      // Also attach to the api's compose network so the api can reach CDP by
      // container IP. Chrome's CDP HTTP discovery rejects Host headers that
      // aren't an IP/localhost (DNS-rebinding protection); going through the
      // container IP on a shared network gives us an IP that Chrome accepts.
      // Best-effort: failure here just falls back to the host-loopback path,
      // which works on dev installs where the api runs on the host.
      await exec("docker", ["network", "connect", "withvibe", containerId])
        .catch((e) =>
          this.logger.warn(
            `Could not attach QA browser to withvibe network: ${(e as Error).message}`
          )
        );

      const vncPort = await this.resolvePublishedPort(
        containerId,
        VNC_INTERNAL_PORT
      );
      const cdpPort = await this.resolvePublishedPort(
        containerId,
        CDP_INTERNAL_PORT
      );
      if (!vncPort || !cdpPort) {
        await this.hardStop(containerId).catch(() => {});
        throw new Error("Failed to resolve QA browser published ports");
      }

      await this.prisma.client.env.update({
        where: { id: envId },
        data: {
          qaBrowserContainerId: containerId,
          qaBrowserCdpPort: cdpPort,
          qaBrowserVncPort: vncPort,
          qaBrowserStatus: "running",
          qaBrowserError: null,
        },
      });

      this.logger.info(
        `Env ${envId}: started QA browser ${containerId.slice(0, 12)} — VNC 127.0.0.1:${vncPort}, CDP 127.0.0.1:${cdpPort}`
      );
      return { ok: true, containerId, cdpPort, vncPort };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.client.env.update({
        where: { id: envId },
        data: {
          qaBrowserContainerId: null,
          qaBrowserCdpPort: null,
          qaBrowserVncPort: null,
          qaBrowserStatus: "error",
          qaBrowserError: msg,
        },
      });
      return { ok: false, error: msg };
    }
  }

  async stop(envId: string): Promise<{ ok: true }> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { qaBrowserContainerId: true },
    });
    if (env?.qaBrowserContainerId) {
      await this.hardStop(env.qaBrowserContainerId).catch((err) => {
        this.logger.warn(
          `Env ${envId}: failed to remove QA browser ${env.qaBrowserContainerId}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }
    await this.prisma.client.env.update({
      where: { id: envId },
      data: {
        qaBrowserContainerId: null,
        qaBrowserCdpPort: null,
        qaBrowserVncPort: null,
        qaBrowserStatus: "stopped",
        qaBrowserError: null,
      },
    });
    return { ok: true };
  }

  async stopQuiet(envId: string): Promise<void> {
    await this.stop(envId).catch(() => {});
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
      const preferred = names.find((n) => n.endsWith("_default"));
      return preferred || names[0];
    } catch {
      return null;
    }
  }

  private async resolvePublishedPort(
    containerId: string,
    internalPort: number
  ): Promise<number | null> {
    try {
      const { stdout } = await exec(
        "docker",
        ["port", containerId, String(internalPort)],
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
    await exec("docker", ["rm", "-f", containerId], { timeout: 30_000 });
  }
}
