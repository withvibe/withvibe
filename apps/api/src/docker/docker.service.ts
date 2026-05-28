import { Injectable } from "@nestjs/common";
import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { access, readdir, readFile } from "fs/promises";
import path from "path";
import { ensureEnvDir } from "../common/repo-base-dir";
import { PrismaService } from "../prisma/prisma.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import { StorageService } from "../storage/storage.service";
import { detectDatabasesFromFile } from "./database-detection";
import { composeProjectName } from "./compose-naming";
import { readSharedServices } from "../templates/compose-rewriter";
import {
  assertComposeFileSafe,
  ComposeSecurityError,
} from "./compose-security";
import { DbViewerService } from "./db-viewer.service";
import { BrowserSidecarService } from "./browser-sidecar.service";
import { PlaywrightMcpService } from "./playwright-mcp.service";
import { CodeServerService } from "./code-server.service";
import { CodeTunnelService } from "./code-tunnel.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

const exec = promisify(execFile);

// ---------- constants ------------------------------------------------------

const LOG_BUFFER_MAX = 120_000; // chars per env

const COMPOSE_FILENAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

const NON_HTTP_PORTS = new Set<number>([
  22, 25, 465, 587, 53, 1433, 1521, 1883, 8883, 2181, 3306, 5432, 5672, 6379,
  9042, 9092, 9093, 11211, 27017, 27018, 27019,
]);

const PREFERRED_WEB_PORTS = [
  3000, 3001, 3002, 3003, 5173, 5174, 4200, 8080, 8081, 8082, 8000, 8001, 5000,
  5001, 4000, 4001, 80, 443,
];

// ---------- types ----------------------------------------------------------

type LogSubscriber = (chunk: string) => void;
type PsRecord = {
  Service?: string;
  State?: string;
  Publishers?: Array<{ PublishedPort?: number; TargetPort?: number }>;
};
type PortCandidate = { published: number; target: number | null };
type ComposeContext = {
  composeFile: string;
  source: "custom" | "workspace" | "repo";
  repoName?: string;
  // The env's own directory — the containment root the compose-security
  // gate uses: bind-mount sources must resolve inside it.
  envDir: string;
};

// ---------- service --------------------------------------------------------

/**
 * Docker-compose lifecycle for envs: start / stop / rebuild, in-memory log
 * buffer with SSE-friendly subscribe semantics, and `spawnLogProcess` for
 * tailing container stdout once services are up.
 *
 * State (logBuffers, logSubs) lives on the singleton. Reset when the Nest
 * process restarts. BullMQ + Redis can replace this for durability later.
 */
@Injectable()
export class DockerService {
  private readonly logBuffers = new Map<string, string[]>();
  private readonly logSubs = new Map<string, Set<LogSubscriber>>();

  constructor(
    @InjectPinoLogger(DockerService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly envClones: EnvCloneService,
    private readonly storage: StorageService,
    private readonly dbViewer: DbViewerService,
    private readonly qaBrowser: BrowserSidecarService,
    private readonly playwrightMcp: PlaywrightMcpService,
    private readonly codeServer: CodeServerService,
    private readonly codeTunnel: CodeTunnelService
  ) {}

  // ---------- log buffer (public API) --------------------------------------

  subscribeLogs(envId: string, onChunk: LogSubscriber): () => void {
    // Replay backlog first so new subscribers see what already happened.
    const buf = this.logBuffers.get(envId) || [];
    for (const c of buf) onChunk(c);
    const subs = this.logSubs.get(envId) || new Set();
    subs.add(onChunk);
    this.logSubs.set(envId, subs);
    return () => {
      subs.delete(onChunk);
      if (subs.size === 0) this.logSubs.delete(envId);
    };
  }

  clearLogBuffer(envId: string) {
    this.logBuffers.delete(envId);
  }

  /**
   * Snapshot of the log buffer as a single string, optionally tail-limited.
   * Used by the docker MCP server so the agent sees the same logs the user
   * sees in the UI log panel.
   */
  getLogBufferSnapshot(envId: string, maxChars = 8000): string {
    const joined = (this.logBuffers.get(envId) || []).join("");
    if (joined.length <= maxChars) return joined;
    return joined.slice(joined.length - maxChars);
  }

  private pushLog(envId: string, chunk: string) {
    if (!chunk) return;
    const buf = this.logBuffers.get(envId) || [];
    buf.push(chunk);
    let total = buf.reduce((n, s) => n + s.length, 0);
    while (total > LOG_BUFFER_MAX && buf.length > 1) {
      total -= (buf.shift() || "").length;
    }
    this.logBuffers.set(envId, buf);
    const subs = this.logSubs.get(envId);
    if (subs) for (const s of subs) s(chunk);
  }

  composeProjectName(envId: string): string {
    return composeProjectName(envId);
  }

  // ---------- per-env Traefik network (Phase 2 multi-tenant isolation) ------
  //
  // Each subdomain-routed env gets its OWN external Docker network
  // (`<project>-edge`) instead of every env sharing one flat proxy network.
  // Envs therefore never share an L2/L3 segment, so one env's bare service
  // name can't resolve to another env's container. Traefik is the only thing
  // bridged across envs — the platform connects it to each env's edge net so
  // it can still route public traffic. The network is platform-managed
  // (declared `external: true` in the rewritten compose) so it carries no
  // `com.docker.compose.project` label and the sidecar/runner network
  // resolution (db-viewer.findEnvNetwork etc.) is completely unaffected.

  /** Cached resolved Traefik container name (see resolveTraefikContainer). */
  private resolvedTraefik: string | null = null;

  /** The Traefik container to bridge onto env edge nets. Honors
   * WITHVIBE_TRAEFIK_CONTAINER; otherwise discovers the running Traefik by its
   * Compose service label, so the `-1` replica suffix and the stack's project
   * name are never assumed. (The old hardcoded "withvibe-traefik" missed the
   * `-1` suffix, so `network connect` failed silently and envs 504'd.) Falls
   * back to the conventional name; only a successful discovery is cached. */
  private async resolveTraefikContainer(): Promise<string> {
    const override = process.env.WITHVIBE_TRAEFIK_CONTAINER;
    if (override) return override;
    if (this.resolvedTraefik) return this.resolvedTraefik;
    try {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "--filter",
          "label=com.docker.compose.service=traefik",
          "--format",
          "{{.Names}}",
        ],
        { timeout: 10_000 }
      );
      const name = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)[0];
      if (name) {
        this.resolvedTraefik = name;
        return name;
      }
    } catch {
      // daemon not ready / no match — fall back and retry on the next call
    }
    return "withvibe-traefik-1";
  }

  /** This env's per-env proxy network name, or null when the env is not
   * subdomain-routed (port-mode envs have no Traefik and publish host
   * ports instead, so there is nothing to isolate or connect). */
  private async perEnvProxyNet(envId: string): Promise<string | null> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { routingMode: true },
    });
    return env?.routingMode === "subdomain"
      ? `${this.composeProjectName(envId)}-edge`
      : null;
  }

  /** Create the env's edge network BEFORE `compose up` (the rewritten compose
   * declares it `external: true`, so it must already exist). Gated on the
   * materialized compose actually referencing it, so envs materialized before
   * Phase 2 (still on the shared net) don't accumulate an orphan network.
   * Idempotent + best-effort: "already exists" and a missing daemon are fine. */
  private async ensureEnvProxyNet(
    envId: string,
    composeFile: string
  ): Promise<void> {
    const net = await this.perEnvProxyNet(envId);
    if (!net) return;
    let compose = "";
    try {
      compose = await readFile(composeFile, "utf8");
    } catch {
      return;
    }
    if (!compose.includes(net)) return; // legacy compose still on shared net
    await exec(
      "docker",
      ["network", "create", "--label", `com.withvibe.env=${envId}`, net],
      { timeout: 15_000 }
    ).catch(() => undefined);
    this.pushLog(envId, `[net] per-env proxy network ${net} ready\n`);
  }

  /** Connect Traefik to this env's edge net so it can route to the env's
   * exposed services. No-op for legacy envs (no edge net) and idempotent when
   * Traefik is already attached. A *real* failure is logged loudly — it means
   * the env's public hostname will 504 until fixed, which must never again be
   * a silent swallow. */
  private async connectTraefik(envId: string): Promise<void> {
    const net = await this.perEnvProxyNet(envId);
    if (!net) return;
    // Legacy (pre-isolation) envs reference the shared net, not `-edge`, so the
    // edge net is never created — there is nothing to bridge.
    const edgeExists = await exec("docker", ["network", "inspect", net], {
      timeout: 10_000,
    })
      .then(() => true)
      .catch(() => false);
    if (!edgeExists) return;
    const traefik = await this.resolveTraefikContainer();
    try {
      await exec("docker", ["network", "connect", net, traefik], {
        timeout: 10_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Idempotent happy path: Traefik is already on the net.
      if (/already exists|endpoint with name/i.test(msg)) return;
      this.logger.warn(
        { envId, net, traefik, err: msg },
        `Failed to attach Traefik (${traefik}) to env edge net ${net}; ` +
          `public routing will 504 until fixed — check WITHVIBE_TRAEFIK_CONTAINER`
      );
      this.pushLog(
        envId,
        `[net] WARN: could not attach Traefik to ${net}: ${msg}\n`
      );
    }
  }

  /** Detach Traefik from the edge net so the network can then be removed. */
  private async disconnectTraefik(envId: string): Promise<void> {
    const net = await this.perEnvProxyNet(envId);
    if (!net) return;
    const traefik = await this.resolveTraefikContainer();
    await exec("docker", ["network", "disconnect", net, traefik], {
      timeout: 10_000,
    }).catch(() => undefined);
  }

  /** Remove the env's edge net on stop. No-op for legacy envs (net was never
   * created) and silently skipped if still busy — a stray empty network is
   * harmless and gets swept on the next stop. */
  private async removeEnvProxyNet(envId: string): Promise<void> {
    const net = await this.perEnvProxyNet(envId);
    if (!net) return;
    await exec("docker", ["network", "rm", net], { timeout: 10_000 }).catch(
      () => undefined
    );
  }

  // ---------- cross-env shared infra (Phase 3) -----------------------------
  //
  // Phase 3 deliberately punches a CONTROLLED hole through the Phase 1–2
  // isolation so a company can run ONE shared DB across chosen envs. Trust
  // model: an env's compose may carry `x-use-shared` on a service, but that
  // is INTENT ONLY — it grants nothing. The operator authorizes which envs
  // may use shared infra (allowlist by env id, or template id/slug); only
  // then does the platform `docker network connect` the opted-in service to
  // the operator-owned shared network. Fail-closed: disabled unless
  // WITHVIBE_SHARED_NET is set, and unauthorized envs are skipped + logged.
  // The shared resource is reached by its stable name on that network — the
  // env never gets a bare `mysql`/`db` that could collide cross-env.

  private sharedNet(): string {
    return (process.env.WITHVIBE_SHARED_NET || "").trim();
  }

  private sharedAllowlist(name: string): Set<string> {
    return new Set(
      (process.env[name] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  /** Operator-granted authorization for shared infra. Fail-closed: false
   * unless WITHVIBE_SHARED_NET is set AND the env (by id) or its template
   * (by id or slug) is on the operator allowlist. */
  private async isSharedAuthorized(envId: string): Promise<boolean> {
    if (!this.sharedNet()) return false;
    if (this.sharedAllowlist("WITHVIBE_SHARED_ENVS").has(envId)) return true;
    const tpls = this.sharedAllowlist("WITHVIBE_SHARED_TEMPLATES");
    if (tpls.size === 0) return false;
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { templateId: true, template: { select: { slug: true } } },
    });
    if (!env) return false;
    return (
      (env.templateId != null && tpls.has(env.templateId)) ||
      (env.template?.slug != null && tpls.has(env.template.slug))
    );
  }

  /** Connect services that opted into shared infra to the operator's shared
   * network — only when the operator authorized this env. Best-effort. */
  private async attachSharedInfra(
    envId: string,
    proj: string,
    composeFile: string
  ): Promise<void> {
    let optedIn: string[] = [];
    try {
      optedIn = readSharedServices(await readFile(composeFile, "utf8"));
    } catch {
      return;
    }
    if (optedIn.length === 0) return;

    const net = this.sharedNet();
    if (!net) {
      this.pushLog(
        envId,
        `[shared] ${optedIn.join(", ")} requested shared infra but ` +
          `WITHVIBE_SHARED_NET is not configured here — ignored\n`
      );
      return;
    }
    if (!(await this.isSharedAuthorized(envId))) {
      this.pushLog(
        envId,
        `[shared] env not authorized for shared infra — NOT attaching ` +
          `${optedIn.join(", ")} to "${net}" (operator must allowlist this ` +
          `env id or its template via WITHVIBE_SHARED_ENVS / ` +
          `WITHVIBE_SHARED_TEMPLATES)\n`
      );
      return;
    }

    for (const svc of optedIn) {
      let ids: string[] = [];
      try {
        const { stdout } = await exec(
          "docker",
          ["compose", "-p", proj, "ps", "-q", svc],
          { timeout: 10_000 }
        );
        ids = stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      } catch {
        ids = [];
      }
      for (const id of ids) {
        await exec("docker", ["network", "connect", net, id], {
          timeout: 10_000,
        }).catch(() => undefined); // already-connected / missing net → no-op
      }
      if (ids.length > 0)
        this.pushLog(
          envId,
          `[shared] attached ${svc} to shared network "${net}"\n`
        );
    }
  }

  // ---------- compose file resolution --------------------------------------

  private async fileExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async detectCompose(repoPath: string): Promise<string | null> {
    for (const f of COMPOSE_FILENAMES) {
      const p = path.join(repoPath, f);
      if (await this.fileExists(p)) return p;
    }
    return null;
  }

  /** Same as detectCompose but walks subfolders (depth-bounded). For uploads
   *  like `./assets/someConf/docker-compose.yml`. */
  private async detectComposeRecursive(
    dir: string,
    depth = 3
  ): Promise<string | null> {
    const hit = await this.detectCompose(dir);
    if (hit) return hit;
    if (depth <= 0) return null;
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const sub = path.join(dir, name);
      let isDir = false;
      try {
        const st = await access(sub).then(
          () => true,
          () => false
        );
        if (!st) continue;
        const { lstat } = await import("fs/promises");
        const s = await lstat(sub);
        isDir = s.isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const hit = await this.detectComposeRecursive(sub, depth - 1);
      if (hit) return hit;
    }
    return null;
  }

  private async getEnvironmentCompose(
    envId: string
  ): Promise<ComposeContext | { error: string }> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      include: {
        envRepos: { include: { repo: { include: { clone: true } } } },
      },
    });
    if (!env) return { error: "Environment not found" };

    const envDir = this.envClones.envDir(env.workspaceId, envId);
    await ensureEnvDir(envDir);

    // Materialize durable storage (compose + assets) into envDir so Docker
    // can bind-mount. No-op when storage IS the env clone dir.
    await this.storage.syncToEnvClone(env.workspaceId, envId);

    // Ensure an env clone exists for every attached repo whose clone is ready.
    const envClonePaths = new Map<string, string>();
    for (const er of env.envRepos) {
      if (er.repo.clone?.cloneStatus !== "ready") continue;
      const res = await this.envClones.ensureEnvClone(er.id);
      if ("error" in res) {
        return {
          error: `Env clone for ${er.repo.name} failed: ${res.error}`,
        };
      }
      envClonePaths.set(er.id, res.localPath);
    }

    // 1) Env-level custom compose overrides everything.
    if (env.composeFile && env.composeFile.trim()) {
      const customPath = this.storage.composeEnvClonePath(envId, envDir);
      // syncToEnvClone already wrote it; in the rare case the DB has compose
      // but storage doesn't (older envs), fall back to a one-shot write.
      try {
        await access(customPath);
      } catch {
        await this.storage.writeCompose(env.workspaceId, envId, env.composeFile);
        await this.storage.syncToEnvClone(env.workspaceId, envId);
      }
      return { composeFile: customPath, source: "custom", envDir };
    }

    // 2) Uploaded assets folder — if the user dropped a compose under
    //    ./assets/ (or any subfolder of it), treat it like a user-provided
    //    compose.
    const assetsDir = path.join(envDir, "assets");
    const assetCompose = await this.detectComposeRecursive(assetsDir);
    if (assetCompose) {
      return { composeFile: assetCompose, source: "workspace", envDir };
    }

    // 3) Env-root compose — natural spot for multi-repo setups.
    const envRootCompose = await this.detectCompose(envDir);
    if (envRootCompose) {
      return { composeFile: envRootCompose, source: "workspace", envDir };
    }

    // 3) Repo-level compose — first env clone with a compose file wins.
    if (env.envRepos.length === 0) {
      return {
        error:
          "No compose file found at the env root and no repositories attached. Attach a repo, paste a compose file in env settings, or ask the AI to generate one.",
      };
    }

    const readyRepos = env.envRepos.filter((er) => envClonePaths.has(er.id));
    if (readyRepos.length === 0) {
      return { error: "Repositories are still cloning. Try again shortly." };
    }

    for (const er of readyRepos) {
      const clonePath = envClonePaths.get(er.id)!;
      const compose = await this.detectCompose(clonePath);
      if (compose) {
        return {
          composeFile: compose,
          source: "repo",
          repoName: er.repo.name,
          envDir,
        };
      }
    }

    const repoList = readyRepos.map((r) => r.repo.name).join(", ");
    return {
      error:
        `No docker-compose.yml found at the env root or in attached repos (${repoList}).\n\n` +
        "Ask the AI in chat to analyze your repo and generate one — or paste a compose file via the Compose section on this page.",
    };
  }

  // ---------- lifecycle ----------------------------------------------------

  async startEnvironment(envId: string): Promise<void> {
    await this.setStatus(envId, "starting", { error: null });
    void this.startBg(envId);
  }

  async stopEnvironment(envId: string): Promise<void> {
    await this.setStatus(envId, "stopping", { error: null });
    void this.stopBg(envId);
  }

  async rebuildEnvironment(envId: string): Promise<void> {
    await this.setStatus(envId, "building", { error: null });
    void this.rebuildBg(envId);
  }

  /**
   * Per-service lifecycle action. Unlike the env-level methods above, this
   * does NOT touch the env-level `containerStatus` — per-service state is
   * derived from `docker ps` via listEnvContainers. Progress lines land in
   * the same log buffer the SSE endpoint streams.
   *
   * `--no-deps` keeps each action scoped to the named service: rebuilding
   * backend doesn't disturb postgres/redis. `--force-recreate` on rebuild
   * makes sure a new image actually replaces the running container.
   */
  async serviceAction(
    envId: string,
    service: string,
    action: "start" | "stop" | "restart" | "rebuild"
  ): Promise<void> {
    void this.serviceBg(envId, service, action);
  }

  private async serviceBg(
    envId: string,
    service: string,
    action: "start" | "stop" | "restart" | "rebuild"
  ): Promise<void> {
    this.pushLog(envId, `[${action} ${service}] resolving compose…\n`);
    const ctx = await this.getEnvironmentCompose(envId);
    if ("error" in ctx) {
      this.pushLog(envId, `[${action} ${service}] ${ctx.error}\n`);
      return;
    }
    // Run the compose-security gate for ops that re-parse the compose file
    // (start/rebuild can introduce new containers). stop/restart only act on
    // already-running containers, so they don't need it.
    if (action === "start" || action === "rebuild") {
      const tag: "start" | "rebuild" = action === "rebuild" ? "rebuild" : "start";
      if (!(await this.assertComposeSafe(envId, ctx, tag))) return;
    }
    const proj = this.composeProjectName(envId);
    const argMap: Record<typeof action, string[]> = {
      start: ["up", "-d", "--no-deps", service],
      stop: ["stop", service],
      restart: ["restart", service],
      rebuild: [
        "up",
        "-d",
        "--build",
        "--no-deps",
        "--force-recreate",
        service,
      ],
    };
    try {
      await this.runCompose(
        envId,
        proj,
        ctx.composeFile,
        argMap[action],
        10 * 60 * 1000
      );
      this.pushLog(envId, `[${action} ${service}] done\n`);
    } catch (err) {
      this.pushLog(
        envId,
        `[${action} ${service}] FAILED: ${this.formatErr(err)}\n`
      );
    }
  }

  /**
   * Authoritative compose-security gate. Resolves the compose exactly as
   * `docker compose up` will (interpolation/anchors/extends/include) and
   * rejects host-escape directives — privileged, host namespaces, device
   * passthrough, the Docker socket, and bind mounts that resolve outside
   * the env's own directory. Returns true if safe; on rejection it records
   * the env error + log line and returns false.
   *
   * This sits at the single run chokepoint, so it covers EVERY compose
   * source: custom, uploaded asset, env-root (which the autonomous agent
   * writes itself), repo-derived, and post-rewrite template.
   */
  private async assertComposeSafe(
    envId: string,
    ctx: ComposeContext,
    tag: "start" | "rebuild"
  ): Promise<boolean> {
    try {
      await assertComposeFileSafe(
        ctx.composeFile,
        ctx.envDir,
        this.composeProjectName(envId),
        // The rewriter attaches this env's exposed services to its OWN
        // per-env external proxy network (`<project>-edge`, Phase 2 isolation
        // — see TemplateMaterializerService.perEnvProxyNetwork). Allow exactly
        // that, plus the legacy shared PROXY_NETWORK so envs materialized
        // before Phase 2 still pass on restart until re-materialized. Any
        // other external network is still rejected.
        {
          allowedExternalNetworks: [
            process.env.PROXY_NETWORK || "proxy",
            `${this.composeProjectName(envId)}-edge`,
          ],
        }
      );
      return true;
    } catch (err) {
      if (err instanceof ComposeSecurityError) {
        this.pushLog(envId, `[${tag}] ${err.message}\n`);
        await this.setStatus(envId, "error", { error: err.message });
        return false;
      }
      throw err;
    }
  }

  private async startBg(envId: string): Promise<void> {
    this.clearLogBuffer(envId);
    this.pushLog(envId, `[start] resolving compose file…\n`);
    const ctx = await this.getEnvironmentCompose(envId);
    if ("error" in ctx) {
      this.pushLog(envId, `[start] ${ctx.error}\n`);
      await this.setStatus(envId, "error", { error: ctx.error });
      return;
    }
    this.pushLog(
      envId,
      `[start] using compose: ${ctx.composeFile} (${ctx.source})\n`
    );
    if (!(await this.assertComposeSafe(envId, ctx, "start"))) return;
    await this.refreshDetectedDatabases(envId, ctx.composeFile);
    const proj = this.composeProjectName(envId);
    try {
      await this.setStatus(envId, "building");
      await this.ensureEnvProxyNet(envId, ctx.composeFile);
      await this.runCompose(
        envId,
        proj,
        ctx.composeFile,
        ["up", "-d", "--build", "--remove-orphans"],
        15 * 60 * 1000
      );
      await this.finalizeAfterUp(envId, proj, ctx.composeFile);
    } catch (err) {
      const msg = this.formatErr(err);
      await this.setStatus(envId, "error", { error: msg });
    }
  }

  private async stopBg(envId: string): Promise<void> {
    this.pushLog(envId, `[stop] shutting down…\n`);
    // Tear down the DB viewer + QA browser sidecars first — their network
    // goes away with `compose down --remove-orphans`, so stopping them after
    // would fail.
    await this.dbViewer.stopQuiet(envId);
    await this.playwrightMcp.closeForEnv(envId);
    await this.qaBrowser.stopQuiet(envId);
    await this.codeServer.stopQuiet(envId);
    // Per-user tunnel sidecars are long-lived (one per user, shared across
    // envs), so we don't kill them — just disconnect them from this env's
    // compose network so it can be removed cleanly. Their other envs (and
    // the user's IDE state) stay up.
    await this.codeTunnel.stopAllForEnv(envId).catch(() => {});
    // Detach Traefik so the edge net has no endpoints left and can be removed
    // after compose down. Other envs have their own edge nets — unaffected.
    await this.disconnectTraefik(envId);
    const proj = this.composeProjectName(envId);
    try {
      // --remove-orphans: kills renamed containers still labeled for this
      // project. -t 10: give services 10s to shut down cleanly.
      await this.runComposeBare(
        envId,
        proj,
        ["down", "--remove-orphans", "-t", "10"],
        2 * 60 * 1000
      );

      const stragglers = await this.listProjectContainers(proj);
      if (stragglers.length > 0) {
        this.pushLog(
          envId,
          `[stop] ${stragglers.length} container(s) still alive after compose down — force-removing: ${stragglers.join(", ")}\n`
        );
        for (const id of stragglers) {
          try {
            await exec("docker", ["rm", "-f", id], { timeout: 30_000 });
            this.pushLog(envId, `[stop] force-removed ${id}\n`);
          } catch (err) {
            this.pushLog(
              envId,
              `[stop] failed to remove ${id}: ${this.formatErr(err)}\n`
            );
          }
        }
      }

      await this.removeEnvProxyNet(envId);
      await this.setStatus(envId, "stopped", { ports: {} });
      this.pushLog(envId, `[stop] done\n`);
    } catch (err) {
      const msg = this.formatErr(err);
      await this.setStatus(envId, "error", { error: msg });
    }
  }

  private async rebuildBg(envId: string): Promise<void> {
    this.clearLogBuffer(envId);
    this.pushLog(envId, `[rebuild] resolving compose file…\n`);
    const ctx = await this.getEnvironmentCompose(envId);
    if ("error" in ctx) {
      this.pushLog(envId, `[rebuild] ${ctx.error}\n`);
      await this.setStatus(envId, "error", { error: ctx.error });
      return;
    }
    this.pushLog(
      envId,
      `[rebuild] using compose: ${ctx.composeFile} (${ctx.source})\n`
    );
    // Gate BEFORE any teardown so a rejected compose never disrupts a
    // currently-running env.
    if (!(await this.assertComposeSafe(envId, ctx, "rebuild"))) return;
    await this.refreshDetectedDatabases(envId, ctx.composeFile);
    // Rebuild does compose down first — sidecar networks are about to vanish.
    await this.dbViewer.stopQuiet(envId);
    await this.playwrightMcp.closeForEnv(envId);
    await this.qaBrowser.stopQuiet(envId);
    await this.codeServer.stopQuiet(envId);
    await this.codeTunnel.stopAllForEnv(envId).catch(() => {});
    const proj = this.composeProjectName(envId);
    try {
      await this.runCompose(
        envId,
        proj,
        ctx.composeFile,
        ["down", "--remove-orphans", "-t", "10"],
        2 * 60 * 1000
      ).catch(() => {});
      await this.ensureEnvProxyNet(envId, ctx.composeFile);
      await this.runCompose(
        envId,
        proj,
        ctx.composeFile,
        ["up", "-d", "--build", "--remove-orphans"],
        15 * 60 * 1000
      );
      await this.finalizeAfterUp(envId, proj, ctx.composeFile);
    } catch (err) {
      const msg = this.formatErr(err);
      await this.setStatus(envId, "error", { error: msg });
    }
  }

  private async finalizeAfterUp(
    envId: string,
    proj: string,
    composeFile: string
  ): Promise<void> {
    const records = await this.composeRecords(proj);
    if (records.length === 0) {
      const logs = await this.composeLogs(proj);
      await this.setStatus(envId, "error", {
        error: `No containers exist after start.\n\n${this.tail(logs, 3000)}`,
      });
      return;
    }

    const notRunning = records.filter((r) => r.State !== "running");
    if (notRunning.length > 0) {
      const failedNames = notRunning
        .map((r) => `${r.Service ?? "?"} (${r.State ?? "?"})`)
        .join(", ");
      const logs = await this.composeLogs(proj);
      await this.setStatus(envId, "error", {
        error: `Container(s) not running: ${failedNames}\n\n${this.tail(logs, 3000)}`,
      });
      return;
    }

    // Containers are up — bridge Traefik onto this env's edge net so its
    // public hostname(s) start routing. Idempotent across rebuilds.
    await this.connectTraefik(envId);
    // Connect any opt-in services to operator-authorized shared infra.
    await this.attachSharedInfra(envId, proj, composeFile);

    const ports = this.extractPorts(records);
    await this.setStatus(envId, "running", { ports });
  }

  // ---------- compose helpers ----------------------------------------------

  private async composeRecords(proj: string): Promise<PsRecord[]> {
    try {
      const { stdout } = await exec(
        "docker",
        ["compose", "-p", proj, "ps", "-a", "--format", "json"],
        { timeout: 15_000 }
      );
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const records: PsRecord[] = [];
      if (lines.length === 1 && lines[0].startsWith("[")) {
        try {
          records.push(...(JSON.parse(lines[0]) as PsRecord[]));
        } catch {}
      } else {
        for (const l of lines) {
          try {
            records.push(JSON.parse(l) as PsRecord);
          } catch {}
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  private async composeLogs(proj: string, tail = 200): Promise<string> {
    try {
      const { stdout, stderr } = await exec(
        "docker",
        [
          "compose",
          "-p",
          proj,
          "logs",
          "--no-color",
          "--tail",
          String(tail),
        ],
        { timeout: 10_000, maxBuffer: 5 * 1024 * 1024 }
      );
      return stdout + (stderr ? `\n${stderr}` : "");
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      return `${e.stdout || ""}\n${e.stderr || e.message || ""}`;
    }
  }

  private async listProjectContainers(proj: string): Promise<string[]> {
    try {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `label=com.docker.compose.project=${proj}`,
          "--format",
          "{{.ID}}",
        ],
        { timeout: 15_000 }
      );
      return stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  private extractPorts(records: PsRecord[]): Record<string, number> {
    const ports: Record<string, number> = {};
    const candidates: PortCandidate[] = [];
    type Entry = { service: string | null; target: number | null; published: number };
    const seen = new Set<string>();
    const entries: Entry[] = [];
    for (const rec of records) {
      if (rec.State !== "running") continue;
      const service = rec.Service?.trim() || null;
      for (const p of rec.Publishers || []) {
        if (typeof p.PublishedPort !== "number" || p.PublishedPort <= 0) continue;
        const target = typeof p.TargetPort === "number" ? p.TargetPort : null;
        candidates.push({ published: p.PublishedPort, target });
        const dedupeKey = `${service ?? ""}|${target ?? ""}|${p.PublishedPort}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        entries.push({ service, target, published: p.PublishedPort });
      }
    }
    const targetsByService = new Map<string, Set<number | null>>();
    for (const e of entries) {
      if (!e.service) continue;
      const set = targetsByService.get(e.service) ?? new Set();
      set.add(e.target);
      targetsByService.set(e.service, set);
    }
    for (const e of entries) {
      const base = e.service ?? (e.target !== null ? `svc_${e.target}` : null);
      if (!base) continue;
      const multi = e.service ? (targetsByService.get(e.service)?.size ?? 0) > 1 : false;
      const key = multi && e.target !== null ? `${base}_${e.target}` : base;
      ports[key] = e.published;
    }
    const web = this.pickWebPort(candidates);
    if (web !== null) ports.web = web;
    return ports;
  }

  private pickWebPort(candidates: PortCandidate[]): number | null {
    const webCandidates = candidates.filter(
      (c) =>
        !NON_HTTP_PORTS.has(c.published) && !NON_HTTP_PORTS.has(c.target ?? -1)
    );
    if (webCandidates.length === 0) return null;
    for (const p of PREFERRED_WEB_PORTS) {
      const hit = webCandidates.find(
        (c) => c.target === p || c.published === p
      );
      if (hit) return hit.published;
    }
    return webCandidates[0].published;
  }

  // ---------- spawning ----------------------------------------------------

  private spawnComposeStreaming(
    envId: string,
    dockerArgs: string[],
    timeoutMs: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", dockerArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const forward = (buf: Buffer) =>
        this.pushLog(envId, buf.toString("utf-8"));
      child.stdout?.on("data", forward);
      child.stderr?.on("data", forward);

      const timer = setTimeout(() => {
        this.pushLog(
          envId,
          `\n[timeout after ${timeoutMs / 1000}s — killing]\n`
        );
        try {
          child.kill("SIGTERM");
        } catch {}
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        this.pushLog(envId, `\n[spawn error: ${err.message}]\n`);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else {
          const msg = `[docker compose exited with code ${code}]`;
          this.pushLog(envId, `\n${msg}\n`);
          reject(new Error(msg));
        }
      });
    });
  }

  private runCompose(
    envId: string,
    proj: string,
    composeFile: string,
    args: string[],
    timeoutMs: number
  ): Promise<void> {
    return this.spawnComposeStreaming(
      envId,
      ["compose", "-p", proj, "-f", composeFile, ...args],
      timeoutMs
    );
  }

  private runComposeBare(
    envId: string,
    proj: string,
    args: string[],
    timeoutMs: number
  ): Promise<void> {
    return this.spawnComposeStreaming(
      envId,
      ["compose", "-p", proj, ...args],
      timeoutMs
    );
  }

  async spawnLogProcess(
    envId: string
  ): Promise<{ child: ChildProcess } | { error: string }> {
    const ctx = await this.getEnvironmentCompose(envId);
    const proj = this.composeProjectName(envId);
    const args = ["compose", "-p", proj];
    if (!("error" in ctx)) args.push("-f", ctx.composeFile);
    args.push("logs", "-f", "--tail", "200", "--no-color");
    try {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { child };
    } catch (err) {
      return { error: this.formatErr(err) };
    }
  }

  async listEnvContainers(
    envId: string
  ): Promise<{
    containers: {
      id: string;
      name: string;
      service: string;
      status: string;
      image: string;
    }[];
  }> {
    const project = this.composeProjectName(envId);
    try {
      // `service` comes from com.docker.compose.service so the per-service
      // lifecycle endpoint can take it as `docker compose <verb> <service>`
      // without re-parsing the container name. Falls back to the container
      // name when the label is missing (shouldn't happen for compose-owned
      // containers, but defensive).
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          "{{.ID}}\t{{.Names}}\t{{.Label \"com.docker.compose.service\"}}\t{{.Status}}\t{{.Image}}",
        ],
        { timeout: 10_000 }
      );
      const containers = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [idPart, name, service, status, image] = line.split("\t");
          return { id: idPart, name, service: service || name, status, image };
        });
      return { containers };
    } catch {
      return { containers: [] };
    }
  }

  /**
   * Read runtime stdout/stderr of a single compose service in this env. Works
   * for both running and stopped/crashed containers (uses `docker ps -a`), so
   * it is the right tool for diagnosing app-level errors once the stack is up.
   * Different from getLogBufferSnapshot, which only holds the compose
   * lifecycle/build output streamed during start/rebuild.
   */
  async getServiceLogs(
    envId: string,
    service: string,
    tail: number
  ): Promise<
    | {
        ok: true;
        text: string;
        service: string;
        containerIds: string[];
      }
    | {
        ok: false;
        error: string;
        knownServices: string[];
      }
  > {
    const project = this.composeProjectName(envId);
    let containerIds: string[] = [];
    try {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--filter",
          `label=com.docker.compose.service=${service}`,
          "--format",
          "{{.ID}}",
        ],
        { timeout: 10_000 }
      );
      containerIds = stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (err) {
      return {
        ok: false,
        error: `docker ps failed: ${(err as Error).message}`,
        knownServices: [],
      };
    }
    if (containerIds.length === 0) {
      const { containers } = await this.listEnvContainers(envId);
      const knownServices = Array.from(
        new Set(containers.map((c) => c.service))
      ).sort();
      return {
        ok: false,
        error: `No container found for service "${service}" in env ${envId}.`,
        knownServices,
      };
    }
    const blocks: string[] = [];
    for (const id of containerIds) {
      try {
        const { stdout, stderr } = await exec(
          "docker",
          ["logs", "--tail", String(tail), "--timestamps", id],
          { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }
        );
        const combined = this.stripAnsi((stdout || "") + (stderr || ""));
        blocks.push(
          containerIds.length > 1
            ? `--- container ${id} ---\n${combined}`
            : combined
        );
      } catch (err) {
        blocks.push(
          `--- container ${id}: failed to read logs (${(err as Error).message}) ---`
        );
      }
    }
    return {
      ok: true,
      text: blocks.join("\n").trimEnd(),
      service,
      containerIds,
    };
  }

  private async refreshDetectedDatabases(
    envId: string,
    composeFile: string
  ): Promise<void> {
    const detected = await detectDatabasesFromFile(composeFile);
    await this.prisma.client.env.update({
      where: { id: envId },
      data: { detectedDatabases: JSON.parse(JSON.stringify(detected)) },
    });
    if (detected.length > 0) {
      const summary = detected
        .map((d) => `${d.service} (${d.engine})`)
        .join(", ");
      this.pushLog(envId, `[start] detected databases: ${summary}\n`);
    }
  }

  // ---------- status + error helpers ---------------------------------------

  private async setStatus(
    envId: string,
    status: string,
    extra: {
      error?: string | null;
      ports?: Record<string, number>;
    } = {}
  ): Promise<void> {
    await this.prisma.client.env.update({
      where: { id: envId },
      data: {
        containerStatus: status,
        lastContainerAt: new Date(),
        ...(extra.error !== undefined && { containerError: extra.error }),
        ...(extra.ports !== undefined && {
          containerPorts: JSON.parse(JSON.stringify(extra.ports)),
        }),
      },
    });
  }

  private stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  }

  private tail(s: string, max: number): string {
    const cleaned = this.stripAnsi(s).trim();
    return cleaned.length > max ? "…" + cleaned.slice(-max) : cleaned;
  }

  private formatErr(err: unknown): string {
    if (err instanceof Error) {
      const e = err as Error & {
        stderr?: string | Buffer;
        stdout?: string | Buffer;
      };
      const stderr =
        typeof e.stderr === "string"
          ? e.stderr
          : e.stderr?.toString("utf-8") || "";
      const stdout =
        typeof e.stdout === "string"
          ? e.stdout
          : e.stdout?.toString("utf-8") || "";
      const combined = [stdout, stderr]
        .filter((s) => s.trim())
        .join("\n")
        .trim();
      if (combined) return this.tail(combined, 3000);
      return this.tail(err.message, 3000);
    }
    return this.tail(String(err), 3000);
  }
}
