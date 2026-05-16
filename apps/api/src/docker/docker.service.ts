import { Injectable, Logger } from "@nestjs/common";
import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import { access, readdir } from "fs/promises";
import path from "path";
import { ensureEnvDir } from "../common/repo-base-dir";
import { PrismaService } from "../prisma/prisma.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import { StorageService } from "../storage/storage.service";
import { detectDatabasesFromFile } from "./database-detection";
import { composeProjectName } from "./compose-naming";
import { DbViewerService } from "./db-viewer.service";
import { BrowserSidecarService } from "./browser-sidecar.service";
import { PlaywrightMcpService } from "./playwright-mcp.service";
import { CodeServerService } from "./code-server.service";

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
  private readonly logger = new Logger(DockerService.name);
  private readonly logBuffers = new Map<string, string[]>();
  private readonly logSubs = new Map<string, Set<LogSubscriber>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly envClones: EnvCloneService,
    private readonly storage: StorageService,
    private readonly dbViewer: DbViewerService,
    private readonly qaBrowser: BrowserSidecarService,
    private readonly playwrightMcp: PlaywrightMcpService,
    private readonly codeServer: CodeServerService
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
      return { composeFile: customPath, source: "custom" };
    }

    // 2) Uploaded assets folder — if the user dropped a compose under
    //    ./assets/ (or any subfolder of it), treat it like a user-provided
    //    compose.
    const assetsDir = path.join(envDir, "assets");
    const assetCompose = await this.detectComposeRecursive(assetsDir);
    if (assetCompose) {
      return { composeFile: assetCompose, source: "workspace" };
    }

    // 3) Env-root compose — natural spot for multi-repo setups.
    const envRootCompose = await this.detectCompose(envDir);
    if (envRootCompose) {
      return { composeFile: envRootCompose, source: "workspace" };
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
    await this.refreshDetectedDatabases(envId, ctx.composeFile);
    const proj = this.composeProjectName(envId);
    try {
      await this.setStatus(envId, "building");
      await this.runCompose(
        envId,
        proj,
        ctx.composeFile,
        ["up", "-d", "--build", "--remove-orphans"],
        15 * 60 * 1000
      );
      await this.finalizeAfterUp(envId, proj);
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
    await this.refreshDetectedDatabases(envId, ctx.composeFile);
    // Rebuild does compose down first — sidecar networks are about to vanish.
    await this.dbViewer.stopQuiet(envId);
    await this.playwrightMcp.closeForEnv(envId);
    await this.qaBrowser.stopQuiet(envId);
    await this.codeServer.stopQuiet(envId);
    const proj = this.composeProjectName(envId);
    try {
      await this.runCompose(
        envId,
        proj,
        ctx.composeFile,
        ["down", "--remove-orphans", "-t", "10"],
        2 * 60 * 1000
      ).catch(() => {});
      await this.runCompose(
        envId,
        proj,
        ctx.composeFile,
        ["up", "-d", "--build", "--remove-orphans"],
        15 * 60 * 1000
      );
      await this.finalizeAfterUp(envId, proj);
    } catch (err) {
      const msg = this.formatErr(err);
      await this.setStatus(envId, "error", { error: msg });
    }
  }

  private async finalizeAfterUp(envId: string, proj: string): Promise<void> {
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
    containers: { id: string; name: string; status: string; image: string }[];
  }> {
    const project = this.composeProjectName(envId);
    try {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}",
        ],
        { timeout: 10_000 }
      );
      const containers = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [idPart, name, status, image] = line.split("\t");
          return { id: idPart, name, status, image };
        });
      return { containers };
    } catch {
      return { containers: [] };
    }
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
