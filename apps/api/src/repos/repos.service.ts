import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import { access, mkdir, rm } from "fs/promises";
import path from "path";
import { PrismaService } from "../prisma/prisma.service";
import { resolveRepoBaseDir } from "../common/repo-base-dir";
import { WorkspaceAccessService } from "../common/workspace-access.service";

const exec = promisify(execFile);

const GITHUB_URL_RE =
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

@Injectable()
export class ReposService {
  private readonly logger = new Logger(ReposService.name);
  private readonly repoLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  private get baseDir(): string {
    return resolveRepoBaseDir();
  }

  private parseGithubUrl(
    url: string
  ): { owner: string; name: string; canonicalUrl: string } | null {
    const match = url.trim().match(GITHUB_URL_RE);
    if (!match) return null;
    const [, owner, name] = match;
    return {
      owner,
      name,
      canonicalUrl: `https://github.com/${owner}/${name}.git`,
    };
  }

  private authenticatedUrl(canonicalUrl: string, token: string | null): string {
    const effective = token || process.env.GITHUB_TOKEN;
    if (!effective) return canonicalUrl;
    return canonicalUrl.replace(
      "https://",
      `https://x-access-token:${encodeURIComponent(effective)}@`
    );
  }

  private async tokenForWorkspace(workspaceId: string): Promise<string | null> {
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { githubToken: true },
    });
    return ws?.githubToken ?? null;
  }

  private localPathFor(workspaceId: string, repoName: string): string {
    return path.join(this.baseDir, workspaceId, repoName);
  }

  /** Serialize operations on a single repo (clone, delete, fetch) to avoid races. */
  private async withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.repoLocks.get(repoId);
    if (existing) await existing.catch(() => {});
    let release!: () => void;
    const lock = new Promise<void>((r) => {
      release = r;
    });
    this.repoLocks.set(repoId, lock);
    try {
      return await fn();
    } finally {
      release();
      if (this.repoLocks.get(repoId) === lock) this.repoLocks.delete(repoId);
    }
  }

  async list(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);
    const repos = await this.prisma.client.repo.findMany({
      where: { workspaceId },
      include: { clone: true },
      orderBy: { createdAt: "asc" },
    });
    return repos.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      defaultForNewEnvs: r.defaultForNewEnvs,
      cloneStatus: r.clone?.cloneStatus || "pending",
      branch: r.clone?.branch,
      errorMsg: r.clone?.errorMsg,
      lastPulledAt: r.clone?.lastPulledAt,
      createdAt: r.createdAt,
    }));
  }

  async add(userId: string, workspaceId: string, url: string) {
    await this.access.admin(userId, workspaceId);
    const parsed = this.parseGithubUrl(url);
    if (!parsed) {
      throw new BadRequestException(
        "Invalid URL — must be https://github.com/owner/repo"
      );
    }

    const existing = await this.prisma.client.repo.findUnique({
      where: { workspaceId_name: { workspaceId, name: parsed.name } },
    });
    if (existing) {
      throw new ConflictException(
        `A repo named "${parsed.name}" already exists`
      );
    }

    const localPath = this.localPathFor(workspaceId, parsed.name);

    const repo = await this.prisma.client.repo.create({
      data: {
        workspaceId,
        name: parsed.name,
        url: parsed.canonicalUrl,
        clone: {
          create: { localPath, cloneStatus: "pending" },
        },
      },
    });

    // Background clone — deferred so the 201 returns immediately.
    setImmediate(() => {
      void this.cloneInBackground(
        repo.id,
        workspaceId,
        parsed.canonicalUrl,
        localPath
      ).catch((err) => {
        this.logger.error(
          `cloneInBackground failed for repo ${repo.id}: ${err}`
        );
      });
    });

    return { id: repo.id };
  }

  private async cloneInBackground(
    repoId: string,
    workspaceId: string,
    canonicalUrl: string,
    localPath: string
  ): Promise<void> {
    await this.withRepoLock(repoId, async () => {
      await this.prisma.client.repoClone.update({
        where: { repoId },
        data: { cloneStatus: "cloning", errorMsg: null },
      });

      try {
        const token = await this.tokenForWorkspace(workspaceId);
        await mkdir(path.dirname(localPath), { recursive: true });
        try {
          await access(localPath);
          await rm(localPath, { recursive: true, force: true });
        } catch {}

        await exec(
          "git",
          [
            "clone",
            "--depth",
            "50",
            this.authenticatedUrl(canonicalUrl, token),
            localPath,
          ],
          {
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            timeout: 5 * 60 * 1000,
          }
        );

        const { stdout: branchOut } = await exec(
          "git",
          ["-C", localPath, "rev-parse", "--abbrev-ref", "HEAD"],
          { timeout: 10_000 }
        );
        const branch = branchOut.trim() || "main";

        await this.prisma.client.repoClone.update({
          where: { repoId },
          data: {
            cloneStatus: "ready",
            branch,
            lastPulledAt: new Date(),
            errorMsg: null,
          },
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // Strip embedded credentials (e.g. https://x-access-token:ghp_...@github.com)
        // before persisting — the message goes to the DB and is rendered in the UI.
        const redacted = raw.replace(
          /https:\/\/[^/\s@]+:[^/\s@]+@/g,
          "https://***@"
        );
        await this.prisma.client.repoClone.update({
          where: { repoId },
          data: { cloneStatus: "error", errorMsg: redacted.slice(0, 500) },
        });
      }
    });
  }

  async retry(userId: string, workspaceId: string, repoId: string) {
    await this.access.admin(userId, workspaceId);
    const repo = await this.prisma.client.repo.findUnique({
      where: { id: repoId },
      include: { clone: true },
    });
    if (!repo || repo.workspaceId !== workspaceId) {
      throw new NotFoundException("Repo not found");
    }
    if (!repo.clone) {
      throw new NotFoundException("Repo clone record not found");
    }
    if (repo.clone.cloneStatus === "cloning") {
      throw new ConflictException("Clone already in progress");
    }

    await this.prisma.client.repoClone.update({
      where: { repoId },
      data: { cloneStatus: "pending", errorMsg: null },
    });

    setImmediate(() => {
      void this.cloneInBackground(
        repo.id,
        workspaceId,
        repo.url,
        repo.clone!.localPath
      ).catch((err) => {
        this.logger.error(
          `cloneInBackground (retry) failed for repo ${repo.id}: ${err}`
        );
      });
    });

    return { ok: true };
  }

  async update(
    userId: string,
    workspaceId: string,
    repoId: string,
    body: { defaultForNewEnvs?: unknown }
  ) {
    await this.access.admin(userId, workspaceId);
    const repo = await this.prisma.client.repo.findUnique({
      where: { id: repoId },
    });
    if (!repo || repo.workspaceId !== workspaceId) {
      throw new NotFoundException("Repo not found");
    }

    const data: { defaultForNewEnvs?: boolean } = {};
    if (typeof body.defaultForNewEnvs === "boolean") {
      data.defaultForNewEnvs = body.defaultForNewEnvs;
    }
    const updated = await this.prisma.client.repo.update({
      where: { id: repoId },
      data,
    });
    return {
      id: updated.id,
      defaultForNewEnvs: updated.defaultForNewEnvs,
    };
  }

  async delete(userId: string, workspaceId: string, repoId: string) {
    await this.access.admin(userId, workspaceId);
    const repo = await this.prisma.client.repo.findUnique({
      where: { id: repoId },
    });
    if (!repo || repo.workspaceId !== workspaceId) {
      throw new NotFoundException("Repo not found");
    }
    const clone = await this.prisma.client.repoClone.findUnique({
      where: { repoId },
    });

    await this.prisma.client.$transaction([
      this.prisma.client.envRepo.deleteMany({ where: { repoId } }),
      this.prisma.client.repoClone.deleteMany({ where: { repoId } }),
      this.prisma.client.repo.delete({ where: { id: repoId } }),
    ]);

    if (clone?.localPath) {
      await rm(clone.localPath, { recursive: true, force: true }).catch(
        () => {}
      );
    }
    return { ok: true };
  }

  /**
   * List branches on the repo's `origin`. Runs `git fetch origin --prune`
   * first so the result reflects current state. Used by the env creation UI
   * to populate the base-branch picker.
   */
  async listRemoteBranches(
    userId: string,
    workspaceId: string,
    repoId: string
  ) {
    await this.access.member(userId, workspaceId);
    const repo = await this.prisma.client.repo.findUnique({
      where: { id: repoId },
      include: { clone: true },
    });
    if (!repo || repo.workspaceId !== workspaceId) {
      throw new NotFoundException("Repo not found");
    }
    if (!repo.clone || repo.clone.cloneStatus !== "ready") {
      return {
        branches: [] as string[],
        defaultBranch: null as string | null,
        cloneStatus: repo.clone?.cloneStatus ?? "pending",
      };
    }

    try {
      await exec(
        "git",
        ["-C", repo.clone.localPath, "fetch", "origin", "--prune"],
        { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
      );
      const { stdout } = await exec(
        "git",
        [
          "-C",
          repo.clone.localPath,
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/remotes/origin",
        ],
        { timeout: 10_000 }
      );
      const branches = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("origin/") && !l.includes("HEAD"))
        .map((l) => l.replace(/^origin\//, ""));
      return {
        branches,
        defaultBranch: repo.clone.branch,
        cloneStatus: "ready" as const,
      };
    } catch {
      return {
        branches: [] as string[],
        defaultBranch: repo.clone.branch,
        cloneStatus: "ready" as const,
      };
    }
  }
}
