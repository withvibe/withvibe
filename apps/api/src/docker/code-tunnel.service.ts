import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { mkdir } from "fs/promises";
import path from "path";
import os from "os";
import { PrismaService } from "../prisma/prisma.service";
import { CodeWorkspaceService } from "../env-clones/code-workspace.service";

const exec = promisify(execFile);

/**
 * Per-(env, user) `code tunnel` lifecycle for the desktop VS Code path.
 *
 * Tunnels run as long-lived child processes on the API host (NOT in a
 * container — `code` needs direct filesystem access to the env's clone
 * dirs, and the tunnel server hosts the Claude Code extension on the API
 * host, not in the user's local VS Code).
 *
 * Per-user auth: each user gets their own `--cli-data-dir` so their
 * Microsoft/GitHub auth token is independent. The dir lives on disk under
 * `<TUNNEL_DATA_DIR>/<userId>/` and survives Nest restarts — that's the
 * persistence the user requested ("don't re-prompt every env").
 *
 * Tunnel name: `wv-<envSuffix>-<userSuffix>` so it's unique per (env, user)
 * but stable, and short enough for Microsoft's tunnel-name limits.
 */
type TunnelHandle = {
  child: ChildProcess;
  tunnelName: string;
  startedAt: number;
};

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

@Injectable()
export class CodeTunnelService implements OnModuleDestroy {
  private readonly logger = new Logger(CodeTunnelService.name);
  // Key: `<userId>:<envId>`. Cleared on Nest exit; tunnels then orphan and
  // can be re-adopted by the same `--name` on next start.
  private readonly tunnels = new Map<string, TunnelHandle>();
  // Active device-code login attempts, keyed by userId. Stops us from
  // spawning multiple `code tunnel user login` for the same user.
  private readonly pendingLogins = new Map<
    string,
    { url: string; code: string; child: ChildProcess; startedAt: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly codeWorkspace: CodeWorkspaceService
  ) {}

  onModuleDestroy() {
    for (const handle of this.tunnels.values()) {
      try {
        handle.child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
    for (const login of this.pendingLogins.values()) {
      try {
        login.child.kill("SIGTERM");
      } catch {
        // best-effort
      }
    }
  }

  // ------ public API -------------------------------------------------------

  async start(
    userId: string,
    envId: string
  ): Promise<StartOk | StartNeedsAuth | StartErr> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        id: true,
        title: true,
        workspaceId: true,
        sandboxBypass: true,
        workspace: { select: { sandboxBypass: true } },
      },
    });
    if (!env) return { ok: false, status: "error", error: "Env not found" };

    const codeBin = await this.resolveCodeBin();
    if (!codeBin) {
      return {
        ok: false,
        status: "error",
        error:
          "The `code` CLI wasn't found on the API host. Install VS Code (which ships the `code` CLI), or set CODE_CLI_PATH in the API env to point at it (e.g. /Applications/Visual Studio Code.app/Contents/Resources/app/bin/code).",
      };
    }

    // Reuse a live tunnel if there is one.
    const key = this.key(userId, envId);
    const existing = this.tunnels.get(key);
    if (existing && !existing.child.killed && existing.child.exitCode === null) {
      return {
        ok: true,
        status: "running",
        tunnelName: existing.tunnelName,
        vscodeUri: this.vscodeUri(
          existing.tunnelName,
          env.workspaceId,
          env.id,
          env.title
        ),
        vscodeDevUrl: this.vscodeDevUrl(
          existing.tunnelName,
          env.workspaceId,
          env.id,
          env.title
        ),
      };
    }

    // Auth check. If logged out, kick off device-code login and return the
    // URL+code for the web UI to surface.
    const dataDir = await this.ensureUserDataDir(userId);
    const authed = await this.checkAuth(codeBin, dataDir);
    if (!authed) {
      const login = await this.beginLogin(codeBin, userId, dataDir);
      if (!login) {
        return {
          ok: false,
          status: "error",
          error:
            "Failed to start the tunnel auth flow. Check the API logs for the `code tunnel user login` output.",
        };
      }
      return {
        ok: false,
        status: "needs_auth",
        loginUrl: login.url,
        loginCode: login.code,
      };
    }

    // Authed → spawn the tunnel.
    await this.codeWorkspace.writeWorkspaceFiles(envId);
    const envDir = this.codeWorkspace.envDir(env.workspaceId, env.id);
    const tunnelName = this.tunnelName(env.id, userId);

    // Pre-install extensions into the tunnel server's user data dir so they
    // are present from the first connection. `code --install-extension` is
    // idempotent — re-running for an already-installed extension is a no-op.
    await this.installDefaultExtensions(codeBin, dataDir);

    try {
      const child = spawn(
        codeBin,
        [
          "tunnel",
          "--accept-server-license-terms",
          "--name",
          tunnelName,
          "--cli-data-dir",
          dataDir,
        ],
        {
          cwd: envDir,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
          // The tunnel server hosts the Claude Code extension, which inherits
          // this env. The API host runs as root, so opening a session in
          // Bypass Permissions mode spawns `claude
          // --dangerously-skip-permissions`, which aborts as root unless
          // IS_SANDBOX=1 (Claude Code's documented escape hatch for
          // sandboxed/containerized hosts). Whether that's enabled is
          // resolved per-env → per-workspace → deployment default; see
          // resolveSandboxEnv.
          env: this.resolveSandboxEnv(
            env.sandboxBypass,
            env.workspace.sandboxBypass
          ),
        }
      );

      // Wait for the tunnel to actually be reachable before returning the
      // vscode:// URI. `code tunnel` prints "Open this link in your browser
      // https://vscode.dev/tunnel/<name>" once Microsoft has registered the
      // tunnel name; before that, the local VS Code's "Connecting to ..."
      // spinner hangs forever because the name isn't resolvable yet.
      // First-run is slower (downloads the VS Code server, ~30-60s).
      const ready = new Promise<{ ok: true } | { ok: false; reason: string }>(
        (resolve) => {
          let settled = false;
          const settle = (r: { ok: true } | { ok: false; reason: string }) => {
            if (settled) return;
            settled = true;
            resolve(r);
          };
          const onChunk = (b: Buffer) => {
            const text = b.toString();
            this.logger.log(`[tunnel ${tunnelName}] ${text.trim()}`);
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
          child.on("exit", (code, signal) => {
            this.logger.log(
              `Tunnel ${tunnelName} exited (code=${code} signal=${signal})`
            );
            this.tunnels.delete(key);
            settle({
              ok: false,
              reason: `code tunnel exited (code=${code} signal=${signal}) before becoming ready`,
            });
          });
          // First-run includes a server download, so give it generous time.
          setTimeout(() => {
            settle({
              ok: false,
              reason:
                "Tunnel did not become ready within 90s. Check API logs for `[tunnel " +
                tunnelName +
                "]` lines.",
            });
          }, 90_000);
        }
      );

      this.tunnels.set(key, {
        child,
        tunnelName,
        startedAt: Date.now(),
      });

      const result = await ready;
      if (!result.ok) {
        try {
          child.kill("SIGTERM");
        } catch {
          // best-effort
        }
        this.tunnels.delete(key);
        return { ok: false, status: "error", error: result.reason };
      }

      return {
        ok: true,
        status: "running",
        tunnelName,
        vscodeUri: this.vscodeUri(
          tunnelName,
          env.workspaceId,
          env.id,
          env.title
        ),
        vscodeDevUrl: this.vscodeDevUrl(
          tunnelName,
          env.workspaceId,
          env.id,
          env.title
        ),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: "error", error: msg };
    }
  }

  async stop(userId: string, envId: string): Promise<{ ok: true }> {
    const key = this.key(userId, envId);
    const handle = this.tunnels.get(key);
    if (handle) {
      try {
        handle.child.kill("SIGTERM");
      } catch {
        // best-effort
      }
      this.tunnels.delete(key);
    }
    return { ok: true };
  }

  async authStatus(
    userId: string
  ): Promise<{ authed: boolean; pendingLoginUrl?: string; pendingLoginCode?: string }> {
    const codeBin = await this.resolveCodeBin();
    const dataDir = await this.ensureUserDataDir(userId);
    const authed = codeBin ? await this.checkAuth(codeBin, dataDir) : false;
    const pending = this.pendingLogins.get(userId);
    return {
      authed,
      pendingLoginUrl: pending?.url,
      pendingLoginCode: pending?.code,
    };
  }

  /** Wipe stored auth for this user (forces a fresh login next time). */
  async logout(userId: string): Promise<{ ok: true }> {
    const dataDir = await this.ensureUserDataDir(userId);
    const codeBin = await this.resolveCodeBin();

    // Kill every running tunnel child for this user. Otherwise the child
    // stays authenticated in-memory and keeps serving the local VS Code,
    // and the next start() short-circuits on the live handle without
    // re-checking auth — so the user never sees a fresh device-code prompt.
    const prefix = `${userId}:`;
    const liveTunnelNames: string[] = [];
    for (const [key, handle] of this.tunnels) {
      if (!key.startsWith(prefix)) continue;
      liveTunnelNames.push(handle.tunnelName);
      try {
        handle.child.kill("SIGTERM");
      } catch {
        // best-effort
      }
      this.tunnels.delete(key);
    }

    if (codeBin) {
      // Unregister each tunnel name from Microsoft so the old name stops
      // being addressable from the local VS Code's cached account.
      for (const name of liveTunnelNames) {
        await exec(
          codeBin,
          ["tunnel", "unregister", "--name", name, "--cli-data-dir", dataDir],
          { timeout: 10_000 }
        ).catch(() => {});
      }
      await exec(
        codeBin,
        ["tunnel", "user", "logout", "--cli-data-dir", dataDir],
        { timeout: 10_000 }
      ).catch(() => {});
    }
    const pending = this.pendingLogins.get(userId);
    if (pending) {
      try {
        pending.child.kill("SIGTERM");
      } catch {
        // best-effort
      }
      this.pendingLogins.delete(userId);
    }
    return { ok: true };
  }

  // ------ helpers ----------------------------------------------------------

  private key(userId: string, envId: string): string {
    return `${userId}:${envId}`;
  }

  /**
   * Build the env for the spawned `code tunnel` child, deciding whether the
   * hosted Claude Code extension may run in Bypass Permissions mode as root.
   *
   * Resolution (first non-null wins): per-env override → workspace default
   * → deployment default (the `IS_SANDBOX` env on the api container, set by
   * docker-compose to `1` by default). When the resolved value is false we
   * explicitly strip `IS_SANDBOX` from the inherited env so the deployment
   * default can't leak through — Claude then runs with permission prompts
   * (Bypass Permissions mode unavailable for that env's tunnel).
   */
  private resolveSandboxEnv(
    envOverride: boolean | null,
    workspaceDefault: boolean | null
  ): NodeJS.ProcessEnv {
    const deploymentDefault = /^(1|true)$/i.test(
      process.env.IS_SANDBOX ?? ""
    );
    const enabled = envOverride ?? workspaceDefault ?? deploymentDefault;
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (enabled) env.IS_SANDBOX = "1";
    else delete env.IS_SANDBOX;
    return env;
  }

  private tunnelName(envId: string, userId: string): string {
    // Microsoft tunnel names: lowercase, alphanumeric+dash, max 20 chars.
    const env = envId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8);
    const user = userId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8);
    return `wv-${env}-${user}`;
  }

  /**
   * `vscode://vscode-remote/tunnel+<tunnelName>/<absolute-path>` opens the
   * user's local VS Code on the tunneled env. We point at the
   * .code-workspace so all repos appear as a multi-root workspace.
   */
  private vscodeUri(
    tunnelName: string,
    workspaceId: string,
    envId: string,
    title: string
  ): string {
    // The tunnel exposes the API host's whole filesystem. The path in the
    // URI must be the absolute path to the .code-workspace on that host
    // (NOT relative to the tunnel's cwd — VS Code resolves it against `/`).
    const envDir = this.codeWorkspace.envDir(workspaceId, envId);
    const wsFile = this.codeWorkspace.workspaceFileName(envId, title);
    const absPath = path.posix.join(envDir, wsFile);
    // `windowId=_blank` forces VS Code to open a fresh window instead of
    // reusing whatever window currently has focus.
    return `vscode://vscode-remote/tunnel+${tunnelName}${absPath}?windowId=_blank`;
  }

  /**
   * Browser fallback: vscode.dev hosts the workbench in the page itself and
   * authenticates via the user's browser GitHub session, sidestepping the
   * local desktop app's Remote Tunnels client (which is the source of the
   * 1006 / "Connecting to ..." hangs we keep seeing).
   */
  private vscodeDevUrl(
    tunnelName: string,
    workspaceId: string,
    envId: string,
    title: string
  ): string {
    const envDir = this.codeWorkspace.envDir(workspaceId, envId);
    const wsFile = this.codeWorkspace.workspaceFileName(envId, title);
    const absPath = path.posix.join(envDir, wsFile);
    return `https://vscode.dev/tunnel/${tunnelName}${absPath}`;
  }

  private tunnelDataRoot(): string {
    return (
      process.env.CODE_TUNNEL_DATA_DIR ||
      path.join(os.homedir(), ".withvibe", "code-tunnel")
    );
  }

  private async ensureUserDataDir(userId: string): Promise<string> {
    const dir = path.join(this.tunnelDataRoot(), userId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private cachedCodeBin: string | null = null;

  /**
   * Resolve the absolute path to the `code` CLI. The Nest process often
   * inherits a non-login PATH that doesn't include VS Code's shim, so just
   * trying `code` against $PATH fails. Order:
   *   1. CODE_CLI_PATH env override
   *   2. Standard macOS install paths (VS Code + Cursor)
   *   3. Standard Linux install paths
   *   4. Fallback to bare `code` in case the shim IS on PATH
   */
  private async resolveCodeBin(): Promise<string | null> {
    if (this.cachedCodeBin) {
      const ok = await this.tryCodeBin(this.cachedCodeBin);
      if (ok) return this.cachedCodeBin;
      this.cachedCodeBin = null;
    }
    const candidates = [
      process.env.CODE_CLI_PATH,
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
      "/Applications/Cursor.app/Contents/Resources/app/bin/code",
      "/usr/local/bin/code",
      "/usr/bin/code",
      "/snap/bin/code",
      "code",
    ].filter((p): p is string => Boolean(p));
    for (const candidate of candidates) {
      if (await this.tryCodeBin(candidate)) {
        this.cachedCodeBin = candidate;
        this.logger.log(`Using \`code\` CLI at ${candidate}`);
        return candidate;
      }
    }
    return null;
  }

  private async tryCodeBin(bin: string): Promise<boolean> {
    try {
      await exec(bin, ["--version"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  private async codeCliAvailable(): Promise<boolean> {
    return (await this.resolveCodeBin()) !== null;
  }

  /**
   * Extensions to install into every tunnel server. Override/extend via the
   * CODE_TUNNEL_EXTENSIONS env var (comma-separated marketplace IDs).
   */
  private defaultExtensionIds(): string[] {
    const base = ["anthropic.claude-code"];
    const extra = (process.env.CODE_TUNNEL_EXTENSIONS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return Array.from(new Set([...base, ...extra]));
  }

  private async installDefaultExtensions(
    codeBin: string,
    dataDir: string
  ): Promise<void> {
    for (const id of this.defaultExtensionIds()) {
      try {
        await exec(
          codeBin,
          ["--install-extension", id, "--cli-data-dir", dataDir, "--force"],
          { timeout: 60_000 }
        );
        this.logger.log(`Tunnel extension ensured: ${id}`);
      } catch (err) {
        this.logger.warn(
          `Failed to pre-install tunnel extension ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  private async checkAuth(codeBin: string, dataDir: string): Promise<boolean> {
    try {
      const { stdout } = await exec(
        codeBin,
        ["tunnel", "user", "show", "--cli-data-dir", dataDir],
        { timeout: 10_000 }
      );
      // `user show` prints account info on success; on logged-out state it
      // exits non-zero (caught below) or prints a clear "not logged in" line.
      const out = stdout.toLowerCase();
      if (out.includes("not logged in") || out.includes("logged out")) {
        return false;
      }
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Spawn `code tunnel user login --provider github` and parse the device-code
   * URL+code from its stderr. Returns the parsed credentials so the web UI
   * can surface them. The child process keeps running until the user
   * confirms in the browser; cleanup happens on exit.
   */
  private async beginLogin(
    codeBin: string,
    userId: string,
    dataDir: string
  ): Promise<{ url: string; code: string } | null> {
    // Reuse an in-flight login attempt instead of spawning a duplicate.
    const existing = this.pendingLogins.get(userId);
    if (
      existing &&
      !existing.child.killed &&
      existing.child.exitCode === null
    ) {
      return { url: existing.url, code: existing.code };
    }

    return new Promise((resolve) => {
      const child = spawn(
        codeBin,
        [
          "tunnel",
          "user",
          "login",
          "--provider",
          "github",
          "--cli-data-dir",
          dataDir,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );

      let resolved = false;
      let urlCaptured: string | null = null;
      let codeCaptured: string | null = null;

      const tryResolve = () => {
        if (resolved || !urlCaptured || !codeCaptured) return;
        resolved = true;
        this.pendingLogins.set(userId, {
          url: urlCaptured,
          code: codeCaptured,
          child,
          startedAt: Date.now(),
        });
        resolve({ url: urlCaptured, code: codeCaptured });
      };

      const onChunk = (b: Buffer) => {
        const text = b.toString();
        // Expected output (stderr):
        //   "To grant access to the server, please log into ..."
        //   "https://github.com/login/device  and use code XXXX-XXXX"
        const urlMatch = text.match(/https?:\/\/[^\s]+/);
        const codeMatch = text.match(/code\s+([A-Z0-9-]{4,})/i);
        if (urlMatch) urlCaptured = urlMatch[0];
        if (codeMatch) codeCaptured = codeMatch[1];
        tryResolve();
      };

      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);

      child.on("exit", (code) => {
        this.logger.log(
          `code tunnel user login (user=${userId}) exited code=${code}`
        );
        this.pendingLogins.delete(userId);
      });
      child.on("error", (err) => {
        this.logger.warn(
          `code tunnel user login spawn error: ${err.message}`
        );
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      });

      // Safety: if we never see the device code line within 15s, give up so
      // the caller doesn't hang forever.
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // best-effort
          }
          resolve(null);
        }
      }, 15_000);
    });
  }
}
