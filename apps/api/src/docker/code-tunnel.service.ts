import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import path from "path";
import { PrismaService } from "../prisma/prisma.service";
import { CodeWorkspaceService } from "../env-clones/code-workspace.service";
import { resolveRepoBaseDir } from "../common/repo-base-dir";
import { composeProjectName } from "./compose-naming";
import { attachToWithvibe } from "./sidecar-net";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

const exec = promisify(execFile);

/**
 * Per-USER `code tunnel` sidecar. Replaces the previous in-api spawn — the
 * old path ran `code tunnel` directly inside the api container, which had
 * the api's docker.sock mount and bind-mount of every workspace's clones,
 * giving the tunnel's terminal effective root on the host.
 *
 * This service spawns ONE container per user (not per env) from the
 * `withvibe-code-tunnel` image:
 *   - non-root `coder` user (uid 1500), no docker socket, no host access
 *   - bind-mount: REPO_BASE_DIR → /workspace (every env the user can reach
 *     today, since per-user-per-env perms don't exist yet; future spawner
 *     will narrow to authorized envs without touching the image)
 *   - per-user named volume: code-tunnel-user-<suffix> → /home/coder
 *     (extensions, .claude config, MS device-code auth — persists across
 *     container restarts and image upgrades; reused for every env this user
 *     opens so they don't reinstall plugins per env)
 *   - lazy `docker network connect` to each env's compose network as the
 *     user opens envs; disconnect before `compose down` (see stopAllForEnv)
 *
 * Tunnel name is per-user (`wv-u-<suffix>`), so opening multiple envs uses
 * the same MS tunnel and the same in-container tunnel server — but the
 * vscode://...?windowId=_blank URI opens a fresh window per env.
 */

const DEFAULT_IMAGE = `withvibe-code-tunnel:${process.env.WITHVIBE_VERSION || "latest"}`;

function preferredImage(): string {
  return process.env.CODE_TUNNEL_IMAGE?.trim() || DEFAULT_IMAGE;
}

// Bind-mount target inside the sidecar. Env clones live at
// /workspace/<workspaceId>/clones/<envId>/<repoName>.
const WORKSPACE_MOUNT_TARGET = "/workspace";

// Where the per-user volume mounts. Everything under here is the user's
// persistent IDE state.
const USER_HOME_MOUNT = "/home/coder";
const CLI_DATA_DIR = `${USER_HOME_MOUNT}/.vscode-cli`;

// Max time we'll wait for `code tunnel` to print its ready line before
// giving up. First start is slow on first connect (server download).
const SIDECAR_READY_TIMEOUT_MS = 90_000;

type StartOk = {
  ok: true;
  status: "running";
  tunnelName: string;
  vscodeUri: string;
  vscodeDevUrl: string;
};
type StartNeedsAuth = {
  ok: false;
  status: "needs_auth";
  loginUrl: string;
  loginCode: string;
};
type StartErr = {
  ok: false;
  status: "error";
  error: string;
};

type PendingLogin = {
  containerName: string;
  url: string;
  code: string;
  startedAt: number;
};

@Injectable()
export class CodeTunnelService implements OnModuleDestroy {
  // In-memory cache of (userId → parsed URL+code) so the web UI doesn't have
  // to re-parse container logs on every poll. Authoritative state lives on
  // the host docker daemon — the login container has a stable per-user name
  // (see loginContainerName) so we can re-find it after an api restart
  // wipes this map (critical in dev where `pnpm` hot-reloads on every save
  // and would otherwise orphan the user's in-flight device-code flow).
  private readonly pendingLogins = new Map<string, PendingLogin>();

  // In-flight image build (so two concurrent "Open in VS Code" clicks share
  // one build instead of racing two `docker build` invocations on a fresh
  // dev box). Mirrors the same pattern in CodeServerService.resolveImage.
  private buildInFlight: Promise<string> | null = null;

  constructor(
    @InjectPinoLogger(CodeTunnelService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly codeWorkspace: CodeWorkspaceService
  ) {}

  async onModuleDestroy() {
    // Intentionally NO-OP: long-lived tunnel sidecars AND in-flight login
    // containers are deliberately left running so a user's IDE session and
    // device-code flow survive api restarts (common in dev with hot reload).
    // The pendingLogins in-memory cache is reseeded from `docker ps` on
    // the next start() call (see findRunningLogin).
  }

  // ------ public API -------------------------------------------------------

  async start(
    userId: string,
    envId: string
  ): Promise<StartOk | StartNeedsAuth | StartErr> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { id: true, title: true, workspaceId: true },
    });
    if (!env) return { ok: false, status: "error", error: "Env not found" };

    const volumeName = this.userVolumeName(userId);
    const containerName = this.userContainerName(userId);
    const tunnelName = this.userTunnelName(userId);

    await this.ensureUserVolume(volumeName);

    if (!(await this.checkAuth(userId, volumeName))) {
      const login = await this.beginLogin(userId, volumeName);
      if (!login.ok) {
        return {
          ok: false,
          status: "error",
          error: login.error,
        };
      }
      return {
        ok: false,
        status: "needs_auth",
        loginUrl: login.url,
        loginCode: login.code,
      };
    }

    await this.codeWorkspace.writeWorkspaceFiles(envId);

    const sidecar = await this.ensureSidecar(
      userId,
      volumeName,
      containerName,
      tunnelName
    );
    if (!sidecar.ok) return sidecar;

    // Connect the user's sidecar to this env's compose network so the
    // tunnel's terminal can dial env services by their compose hostname.
    const project = composeProjectName(envId);
    const envNetwork = await this.findEnvNetwork(project);
    if (envNetwork) {
      await this.connectNetwork(envNetwork, containerName);
    } else {
      this.logger.warn(
        `Env ${envId}: compose network not found (project=${project}). The tunnel will open, but env services won't be reachable from the terminal until the env is started.`
      );
    }

    return {
      ok: true,
      status: "running",
      tunnelName,
      vscodeUri: this.vscodeUri(tunnelName, env.workspaceId, env.id, env.title),
      vscodeDevUrl: this.vscodeDevUrl(
        tunnelName,
        env.workspaceId,
        env.id,
        env.title
      ),
    };
  }

  /**
   * "Close this env's tunnel" from the user's perspective. The per-user
   * sidecar stays running (it serves the user's other envs and holds their
   * IDE state); we just unhook it from THIS env's compose network so the
   * terminal can't reach services that the user is done with.
   */
  async stop(userId: string, envId: string): Promise<{ ok: true }> {
    const containerName = this.userContainerName(userId);
    const project = composeProjectName(envId);
    const envNetwork = await this.findEnvNetwork(project);
    if (envNetwork) {
      await this.disconnectNetwork(envNetwork, containerName).catch(() => {
        // already disconnected / container gone — both fine
      });
    }
    return { ok: true };
  }

  /**
   * Called by DockerService before `compose down --remove-orphans` for an
   * env. Detaches every per-user sidecar still hooked into that env's
   * network so the network can be removed cleanly. Sidecar containers stay
   * up (per-user, not per-env).
   */
  async stopAllForEnv(envId: string): Promise<void> {
    const project = composeProjectName(envId);
    const network = await this.findEnvNetwork(project);
    if (!network) return;
    let names: string[] = [];
    try {
      const { stdout } = await exec(
        "docker",
        [
          "network",
          "inspect",
          network,
          "-f",
          "{{range $k, $v := .Containers}}{{$v.Name}}\n{{end}}",
        ],
        { timeout: 10_000 }
      );
      names = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("withvibe-tunnel-"));
    } catch {
      return;
    }
    for (const name of names) {
      await this.disconnectNetwork(network, name).catch(() => {});
    }
  }

  async authStatus(userId: string): Promise<{
    authed: boolean;
    pendingLoginUrl?: string;
    pendingLoginCode?: string;
  }> {
    const volumeName = this.userVolumeName(userId);
    const authed = (await this.volumeExists(volumeName))
      ? await this.checkAuth(userId, volumeName)
      : false;

    // Auto-evict cached pending-login entry once auth has actually landed,
    // OR if the login container has exited (success or failure). Without
    // this, a successful login still surfaces stale `pendingLoginUrl/Code`
    // to the web UI for one extra poll.
    if (authed) {
      this.pendingLogins.delete(userId);
      await this.removeContainer(this.loginContainerName(userId));
    } else {
      const cached = this.pendingLogins.get(userId);
      if (cached && !(await this.containerAlive(cached.containerName))) {
        this.pendingLogins.delete(userId);
        await this.removeContainer(cached.containerName);
      }
    }

    const pending = this.pendingLogins.get(userId);
    return {
      authed,
      pendingLoginUrl: pending?.url,
      pendingLoginCode: pending?.code,
    };
  }

  /**
   * Wipe MS tunnel auth for this user. Kills the live sidecar (so the next
   * start() forces a fresh login + new server) and unregisters the tunnel
   * name from Microsoft so the old name stops being resolvable from any
   * client still holding it.
   */
  async logout(userId: string): Promise<{ ok: true }> {
    const containerName = this.userContainerName(userId);
    const loginName = this.loginContainerName(userId);
    const volumeName = this.userVolumeName(userId);
    const tunnelName = this.userTunnelName(userId);

    await this.removeContainer(containerName);
    await this.removeContainer(loginName);
    this.pendingLogins.delete(userId);

    if (await this.volumeExists(volumeName)) {
      await this.runOneShot(userId, volumeName, [
        "tunnel",
        "unregister",
        "--name",
        tunnelName,
        "--cli-data-dir",
        CLI_DATA_DIR,
      ]).catch(() => {});
      await this.runOneShot(userId, volumeName, [
        "tunnel",
        "user",
        "logout",
        "--cli-data-dir",
        CLI_DATA_DIR,
      ]).catch(() => {});
    }
    return { ok: true };
  }

  // ------ naming -----------------------------------------------------------

  private userIdSuffix(userId: string): string {
    // Docker container/volume names: lowercase, alphanumeric + dash/underscore.
    // 12 chars of the id is enough collision-resistance with no real risk;
    // we already namespace with `withvibe-tunnel-`.
    return userId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-12);
  }

  private userContainerName(userId: string): string {
    return `withvibe-tunnel-${this.userIdSuffix(userId)}`;
  }

  private loginContainerName(userId: string): string {
    return `withvibe-tunnel-login-${this.userIdSuffix(userId)}`;
  }

  /**
   * Stable per-user hostname passed via `--hostname` to every container we
   * spawn. VS Code CLI's file keychain (the fallback used when no D-Bus
   * Secret Service is available — which is always, in a container) derives
   * its encryption key from the container's hostname. Containers with
   * randomized hostnames can't decrypt each other's tokens, so an auth-check
   * one-shot won't see what the login container just wrote. Pinning a
   * stable hostname per user fixes that and keeps tokens portable across
   * login → check → sidecar.
   *
   * RFC 1123: alphanumeric + dash, ≤ 63 chars, must not start/end with dash.
   */
  private userHostname(userId: string): string {
    return `wv-tunnel-${this.userIdSuffix(userId)}`;
  }

  private userVolumeName(userId: string): string {
    return `code-tunnel-user-${this.userIdSuffix(userId)}`;
  }

  private userTunnelName(userId: string): string {
    // MS tunnel name: lowercase, alphanumeric+dash, ≤20 chars.
    return `wv-u-${this.userIdSuffix(userId)}`;
  }

  // ------ volume / auth ----------------------------------------------------

  private async volumeExists(name: string): Promise<boolean> {
    try {
      await exec("docker", ["volume", "inspect", name], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  private async ensureUserVolume(name: string): Promise<void> {
    if (await this.volumeExists(name)) return;
    await exec("docker", ["volume", "create", name], { timeout: 10_000 });
  }

  /**
   * Run `code <args>` in a one-shot container against the user's volume.
   * Used for auth/unregister calls that don't need the long-lived sidecar.
   *
   * `userId` is required so we can pin `--hostname` to the user's stable
   * value — see userHostname for why.
   */
  private async runOneShot(
    userId: string,
    volumeName: string,
    codeArgs: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    const image = await this.resolveImage();
    const { stdout, stderr } = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--hostname",
        this.userHostname(userId),
        "-v",
        `${volumeName}:${USER_HOME_MOUNT}`,
        "--entrypoint",
        "code",
        image,
        ...codeArgs,
      ],
      { timeout: 30_000 }
    );
    return { stdout, stderr };
  }

  private async checkAuth(userId: string, volumeName: string): Promise<boolean> {
    try {
      const { stdout } = await this.runOneShot(userId, volumeName, [
        "tunnel",
        "user",
        "show",
        "--cli-data-dir",
        CLI_DATA_DIR,
      ]);
      const out = stdout.toLowerCase();
      if (out.includes("not logged in") || out.includes("logged out")) {
        return false;
      }
      return stdout.trim().length > 0;
    } catch {
      // `code tunnel user show` exits non-zero when logged out.
      return false;
    }
  }

  /**
   * Ensure there's a `code tunnel user login` container running for this
   * user and return its device-code URL + code. Idempotent:
   *
   *   - In-memory cache hit AND container still alive → return cached.
   *   - Cache miss but a container with the stable login name is alive
   *     (e.g. api restart after the user already got a code) → re-parse
   *     URL/code from `docker logs` and reseed the cache.
   *   - No container alive → start a fresh one, parse URL/code, cache.
   *
   * Stable name (`withvibe-tunnel-login-<suffix>`) is what lets us survive
   * api restarts mid-flow — critical in dev where hot reload would
   * otherwise orphan the user's device-code attempt.
   */
  private async beginLogin(
    userId: string,
    volumeName: string
  ): Promise<
    | { ok: true; url: string; code: string }
    | { ok: false; error: string }
  > {
    const containerName = this.loginContainerName(userId);

    const cached = this.pendingLogins.get(userId);
    if (cached && (await this.containerAlive(containerName))) {
      return { ok: true, url: cached.url, code: cached.code };
    }
    if (cached) this.pendingLogins.delete(userId);

    // Look for a still-running login container (e.g. survived an api restart
    // because onModuleDestroy is now a no-op). Re-parse its logs so the user
    // sees the SAME device code they're already entering on GitHub.
    if (await this.containerAlive(containerName)) {
      const reparsed = await this.reparseExistingLogin(containerName);
      if (reparsed.ok) {
        this.pendingLogins.set(userId, {
          containerName,
          url: reparsed.url,
          code: reparsed.code,
          startedAt: Date.now(),
        });
        return { ok: true, url: reparsed.url, code: reparsed.code };
      }
      // Container exists but logs don't carry the device-code info we can
      // recognize — kill and start fresh.
      await this.removeContainer(containerName);
    } else {
      // Stale exited container with the same name would block `docker run
      // --name`. Best-effort cleanup.
      await this.removeContainer(containerName);
    }

    try {
      const image = await this.resolveImage();
      await exec(
        "docker",
        [
          "run",
          "-d",
          "--name",
          containerName,
          "--hostname",
          this.userHostname(userId),
          "--label",
          `com.withvibe.code-tunnel-login=${userId}`,
          "-v",
          `${volumeName}:${USER_HOME_MOUNT}`,
          "--entrypoint",
          "code",
          image,
          "tunnel",
          "user",
          "login",
          "--provider",
          "github",
          "--cli-data-dir",
          CLI_DATA_DIR,
        ],
        { timeout: 15_000 }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to start tunnel-login container: ${msg}`);
      return {
        ok: false,
        error: `Failed to start the tunnel-login container: ${msg}`,
      };
    }

    this.logger.info(
      `[tunnel-login ${containerName}] started; tailing logs for device code`
    );
    const parsed = await this.parseLoginLogs(containerName);
    if (parsed.ok) {
      this.pendingLogins.set(userId, {
        containerName,
        url: parsed.url,
        code: parsed.code,
        startedAt: Date.now(),
      });
      return { ok: true, url: parsed.url, code: parsed.code };
    }

    const dump = await this.dumpContainerLogs(containerName);
    await this.removeContainer(containerName);
    const reason = dump.trim()
      ? `Login container output:\n${dump.trim()}`
      : "Login container produced no output";
    this.logger.warn(
      `[tunnel-login ${containerName}] ${parsed.reason}. ${reason}`
    );
    return {
      ok: false,
      error: `${parsed.reason}. ${reason}`,
    };
  }

  /**
   * Re-parse device-code URL + code from a login container that was started
   * by an earlier api process. `docker logs` (without -f) reads the full
   * historical stream, so we get the original device-code line even if the
   * container has been running for minutes.
   */
  private async reparseExistingLogin(
    containerName: string
  ): Promise<
    | { ok: true; url: string; code: string }
    | { ok: false; reason: string }
  > {
    const dump = await this.dumpContainerLogs(containerName);
    if (!dump.trim()) {
      return { ok: false, reason: "Container has produced no output yet" };
    }
    const urlMatch = dump.match(/https?:\/\/[^\s]+/);
    const codeMatch = dump.match(/code\s+([A-Z0-9-]{4,})/i);
    if (!urlMatch || !codeMatch) {
      return {
        ok: false,
        reason: "Container logs don't contain a recognizable device-code line",
      };
    }
    return { ok: true, url: urlMatch[0], code: codeMatch[1] };
  }

  private async dumpContainerLogs(containerId: string): Promise<string> {
    try {
      const { stdout, stderr } = await exec(
        "docker",
        ["logs", containerId],
        { timeout: 5_000 }
      );
      return [stdout, stderr].filter(Boolean).join("\n");
    } catch {
      return "";
    }
  }

  private parseLoginLogs(
    containerName: string
  ): Promise<
    | { ok: true; url: string; code: string }
    | { ok: false; reason: string }
  > {
    return new Promise((resolve) => {
      let resolved = false;
      let urlCaptured: string | null = null;
      let codeCaptured: string | null = null;
      let child: ChildProcess | null = null;

      const settle = (
        value:
          | { ok: true; url: string; code: string }
          | { ok: false; reason: string }
      ) => {
        if (resolved) return;
        resolved = true;
        if (child) {
          try {
            child.kill("SIGTERM");
          } catch {
            // best-effort
          }
        }
        resolve(value);
      };

      child = spawn("docker", ["logs", "-f", containerName], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onChunk = (b: Buffer) => {
        const text = b.toString();
        this.logger.info(`[tunnel-login ${containerName}] ${text.trim()}`);
        const urlMatch = text.match(/https?:\/\/[^\s]+/);
        const codeMatch = text.match(/code\s+([A-Z0-9-]{4,})/i);
        if (urlMatch) urlCaptured = urlMatch[0];
        if (codeMatch) codeCaptured = codeMatch[1];
        if (urlCaptured && codeCaptured) {
          settle({ ok: true, url: urlCaptured, code: codeCaptured });
        }
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.on("exit", () =>
        settle({
          ok: false,
          reason:
            "Login container exited before printing the device-code URL+code",
        })
      );
      setTimeout(
        () =>
          settle({
            ok: false,
            reason:
              "Timed out after 15s waiting for the device-code URL+code from `code tunnel user login`",
          }),
        15_000
      );
    });
  }

  // ------ long-lived sidecar -----------------------------------------------

  private async containerAlive(idOrName: string): Promise<boolean> {
    try {
      const { stdout } = await exec(
        "docker",
        ["inspect", "-f", "{{.State.Running}}", idOrName],
        { timeout: 5_000 }
      );
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  private async removeContainer(idOrName: string): Promise<void> {
    await exec("docker", ["rm", "-f", idOrName], { timeout: 30_000 }).catch(
      () => {
        // already gone
      }
    );
  }

  private async ensureSidecar(
    userId: string,
    volumeName: string,
    containerName: string,
    tunnelName: string
  ): Promise<{ ok: true } | StartErr> {
    if (await this.containerAlive(containerName)) {
      return { ok: true };
    }
    // Exists but stopped → remove so we can create fresh with current image.
    await this.removeContainer(containerName);

    // Best-effort: clear any prior Microsoft tunnel-name registration for
    // this user's tunnel. The MS tunnel service binds a name to one
    // machine identity at a time, so a sidecar respawn after a hostname
    // or container-identity change (e.g. the per-user-hostname rollout)
    // would otherwise hit `websocket error: HTTP error: 404 Not Found`
    // when it tries to attach to a name still owned by the prior identity.
    // `unregister` requires the same machine identity the registration
    // used, which we now have (stable per-user hostname). Silent no-op
    // when there's nothing to unregister, so safe to always run.
    await this.runOneShot(userId, volumeName, [
      "tunnel",
      "unregister",
      "--cli-data-dir",
      CLI_DATA_DIR,
    ]).catch(() => {
      // unregister failures are non-fatal; if there's nothing to clear,
      // the next `tunnel` call below will succeed; if there's a real
      // conflict, `waitForTunnelReady` will surface the error.
    });

    const repoBase = resolveRepoBaseDir();
    const image = await this.resolveImage();
    const dockerArgs = [
      "run",
      "-d",
      "--name",
      containerName,
      "--hostname",
      this.userHostname(userId),
      "--restart",
      "unless-stopped",
      // Safety net: VS Code Server + Claude Code extension fit comfortably
      // under 1.5 GB; this just stops a runaway extension from being able
      // to take down the host. Adjustable via WITHVIBE_TUNNEL_MEMORY (e.g.
      // `2g`, `1024m`) if a workspace really does need more.
      "--memory",
      process.env.WITHVIBE_TUNNEL_MEMORY?.trim() || "1536m",
      "--label",
      `com.withvibe.code-tunnel-user=${userId}`,
      // Env clones bind: REPO_BASE_DIR → /workspace. Today: every workspace's
      // every env. Once per-user-per-env perms ship, this becomes a series of
      // narrower mounts.
      "-v",
      `${repoBase}:${WORKSPACE_MOUNT_TARGET}`,
      // Per-user persistent IDE state.
      "-v",
      `${volumeName}:${USER_HOME_MOUNT}`,
      "-e",
      `TUNNEL_NAME=${tunnelName}`,
      image,
    ];

    try {
      await exec("docker", dockerArgs, { timeout: 60_000 });
    } catch (err) {
      return {
        ok: false,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Same trick code-server uses: join `withvibe` so a containerized api
    // can reach the sidecar by IP (no published port here — the only
    // consumer is `code tunnel` talking outbound to Microsoft).
    await attachToWithvibe(containerName);

    const ready = await this.waitForTunnelReady(containerName);
    if (!ready.ok) {
      await this.removeContainer(containerName);
      return { ok: false, status: "error", error: ready.reason };
    }
    return { ok: true };
  }

  private waitForTunnelReady(
    containerName: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return new Promise((resolve) => {
      let settled = false;
      let child: ChildProcess | null = null;
      const settle = (r: { ok: true } | { ok: false; reason: string }) => {
        if (settled) return;
        settled = true;
        if (child) {
          try {
            child.kill("SIGTERM");
          } catch {
            // best-effort
          }
        }
        resolve(r);
      };
      child = spawn("docker", ["logs", "-f", containerName], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const onChunk = (b: Buffer) => {
        const text = b.toString();
        this.logger.info(`[tunnel-sidecar ${containerName}] ${text.trim()}`);
        if (
          /Open this link in your browser/i.test(text) ||
          /vscode\.dev\/tunnel\//i.test(text) ||
          /Connected to an existing tunnel process/i.test(text)
        ) {
          settle({ ok: true });
        }
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.on("exit", () =>
        settle({
          ok: false,
          reason: `Tunnel sidecar ${containerName} exited before becoming ready`,
        })
      );
      setTimeout(
        () =>
          settle({
            ok: false,
            reason: `Tunnel sidecar ${containerName} did not become ready within ${SIDECAR_READY_TIMEOUT_MS / 1000}s. Check api logs for [tunnel-sidecar ${containerName}] lines.`,
          }),
        SIDECAR_READY_TIMEOUT_MS
      );
    });
  }

  // ------ networking -------------------------------------------------------

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
      if (!names.length) return null;
      // Prefer the `_default` net if compose created multiple.
      const preferred = names.find((n) => n.endsWith("_default"));
      return preferred || names[0];
    } catch {
      return null;
    }
  }

  private async connectNetwork(
    network: string,
    container: string
  ): Promise<void> {
    try {
      await exec("docker", ["network", "connect", network, container], {
        timeout: 10_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        /already exists in network/i.test(msg) ||
        /endpoint with name .* already exists/i.test(msg)
      ) {
        return;
      }
      this.logger.warn(
        `Failed to connect ${container} to ${network}: ${msg}`
      );
    }
  }

  private async disconnectNetwork(
    network: string,
    container: string
  ): Promise<void> {
    await exec("docker", ["network", "disconnect", network, container], {
      timeout: 10_000,
    });
  }

  // ------ image resolution -------------------------------------------------

  /**
   * Resolve the image tag to use, auto-building from the in-tree Dockerfile
   * if it's missing locally. Same lazy-build pattern CodeServerService uses
   * — no manual `docker build` needed on a fresh dev box. There's no
   * upstream fallback (this is our image), so a failed build surfaces back
   * to the caller as an error.
   *
   * Build args (CODE_TUNNEL_APT_PACKAGES, CODE_TUNNEL_EXTENSIONS) are read
   * from the api's process env on a lazy build. In a fresh dev install
   * they're typically empty, which gives a minimal image (Claude Code
   * extension only). For full operator customization, build via
   * `withvibe upgrade` / `scripts/build-bundle.sh` which honor the
   * configured values.
   */
  private async resolveImage(): Promise<string> {
    const preferred = preferredImage();
    if (await this.imageExists(preferred)) return preferred;
    const buildContext = this.findBuildContext();
    if (!buildContext) {
      throw new Error(
        `Image ${preferred} not found and no build context shipped. Build manually: docker build -t ${preferred} apps/api/code-tunnel-image`
      );
    }
    if (!this.buildInFlight) {
      this.buildInFlight = this.buildImage(preferred, buildContext).finally(
        () => {
          this.buildInFlight = null;
        }
      );
    }
    return this.buildInFlight;
  }

  private async imageExists(tag: string): Promise<boolean> {
    try {
      await exec("docker", ["image", "inspect", tag], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Walk up from this file looking for `code-tunnel-image/Dockerfile`. Works
   * both in dev (`apps/api/src/docker/...`) and in a built dist
   * (`apps/api/dist/...`). Returns null if the build context isn't shipped
   * with the deployment (e.g. a from-registry install that lost the source).
   */
  private findBuildContext(): string | null {
    let dir = __dirname;
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, "code-tunnel-image", "Dockerfile");
      if (existsSync(candidate)) return path.dirname(candidate);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  }

  private buildImage(tag: string, context: string): Promise<string> {
    this.logger.info(
      `Auto-building ${tag} from ${context} — this happens once per dev box and may take a couple minutes.`
    );
    const args = ["build", "-t", tag];
    const apt = process.env.CODE_TUNNEL_APT_PACKAGES?.trim();
    const exts = process.env.CODE_TUNNEL_EXTENSIONS?.trim();
    if (apt) args.push("--build-arg", `CODE_TUNNEL_APT_PACKAGES=${apt}`);
    if (exts) args.push("--build-arg", `CODE_TUNNEL_EXTENSIONS=${exts}`);
    args.push(context);

    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (b: Buffer) =>
        this.logger.debug(`[tunnel-build ${tag}] ${b.toString().trim()}`)
      );
      child.stderr?.on("data", (b: Buffer) =>
        this.logger.debug(`[tunnel-build ${tag}] ${b.toString().trim()}`)
      );
      // First build downloads the VS Code CLI, Node, the Claude Code
      // extension, and (optionally) extras — give it 10 min on a cold box.
      const timer = setTimeout(
        () => {
          try {
            child.kill("SIGTERM");
          } catch {
            // best-effort
          }
        },
        10 * 60 * 1000
      );
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          this.logger.info(`Built ${tag} successfully.`);
          resolve(tag);
        } else {
          reject(new Error(`docker build exited with code ${code}`));
        }
      });
    });
  }

  // ------ URIs -------------------------------------------------------------

  private vscodeUri(
    tunnelName: string,
    workspaceId: string,
    envId: string,
    title: string
  ): string {
    const wsFile = this.codeWorkspace.workspaceFileName(envId, title);
    const absPath = path.posix.join(
      WORKSPACE_MOUNT_TARGET,
      workspaceId,
      "clones",
      envId,
      wsFile
    );
    return `vscode://vscode-remote/tunnel+${tunnelName}${absPath}?windowId=_blank`;
  }

  private vscodeDevUrl(
    tunnelName: string,
    workspaceId: string,
    envId: string,
    title: string
  ): string {
    const wsFile = this.codeWorkspace.workspaceFileName(envId, title);
    const absPath = path.posix.join(
      WORKSPACE_MOUNT_TARGET,
      workspaceId,
      "clones",
      envId,
      wsFile
    );
    return `https://vscode.dev/tunnel/${tunnelName}${absPath}`;
  }
}
