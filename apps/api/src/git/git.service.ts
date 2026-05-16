import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";

const exec = promisify(execFile);

type RepoStatus = {
  envRepoId: string;
  name: string;
  branch: string | null;
  baseBranch: string | null;
  branchUrl: string | null;
  envCloneStatus: string;
  ready: boolean;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  files: { path: string; index: string; workTree: string }[];
};

type GithubLocator = { owner: string; repo: string };

type PullSuggestedAction = {
  id:
    | "ask-devops"
    | "retry"
    | "discard-local"
    | "confirm-discard"
    | "cancel"
    | "open-settings";
  label: string;
  description: string;
};

type PullNeedsAttention = {
  kind:
    | "dirty-blocked"
    | "diverged"
    | "merge-conflict"
    | "stash-pop-conflict"
    | "no-remote";
  message: string;
  conflictedFiles?: string[];
  suggestedActions: PullSuggestedAction[];
};

type PullResult = {
  ok: boolean;
  envRepoId: string;
  name: string;
  branch: string | null;
  mode: "auto-stash" | "discard";
  pulledCommits: number;
  stashed: boolean;
  stashRestored: boolean;
  backupRef: string | null;
  notice?: string;
  needsAttention?: PullNeedsAttention;
  error?: string;
};

@Injectable()
export class GitService {
  private readonly logger = new Logger(GitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  // ---- helpers --------------------------------------------------------

  private async assertEnv(userId: string, workspaceId: string, envId: string) {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
  }

  private async loadEnvRepo(envId: string, envRepoId: string) {
    const er = await this.prisma.client.envRepo.findUnique({
      where: { id: envRepoId },
      include: { repo: true, env: { select: { workspaceId: true } } },
    });
    if (!er || er.envId !== envId) {
      throw new NotFoundException("Repo not in this env");
    }
    return er;
  }

  // Defense in depth: even though env clones always live on a dedicated
  // `env/<slug>-<id>` branch, refuse to push if the active branch happens
  // to match the protected base (main/master or whatever EnvRepo.baseBranch
  // is set to). Toggleable via `Workspace.protectBaseBranch`.
  private async assertNotProtectedBranch(
    workspaceId: string,
    branch: string,
    baseBranch: string | null
  ) {
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { protectBaseBranch: true },
    });
    if (!ws?.protectBaseBranch) return;
    const protectedNames = new Set(
      [baseBranch, "main", "master"].filter(Boolean) as string[]
    );
    if (protectedNames.has(branch)) {
      throw new BadRequestException(
        `Refusing to push: branch "${branch}" is protected. ` +
          `Disable Workspace.protectBaseBranch to override.`
      );
    }
  }

  private parseGithubUrl(url: string): GithubLocator | null {
    // matches https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git)
    const m =
      url.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:\/)?$/) || null;
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
  }

  private async run(
    cwd: string,
    args: string[],
    timeoutMs = 30_000,
    env?: Record<string, string>
  ): Promise<string> {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024, // 50 MB — big diffs
      env: env ? { ...process.env, ...env } : process.env,
    });
    return stdout;
  }

  // Treats fatal errors as soft failures so status can still report when
  // a repo isn't initialized/ready yet.
  private async tryRun(
    cwd: string,
    args: string[],
    timeoutMs = 30_000
  ): Promise<string | null> {
    try {
      return await this.run(cwd, args, timeoutMs);
    } catch {
      return null;
    }
  }

  // ---- status ---------------------------------------------------------

  async repoStatus(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string
  ): Promise<RepoStatus> {
    await this.assertEnv(userId, workspaceId, envId);
    const er = await this.loadEnvRepo(envId, envRepoId);
    return this.computeStatus(er);
  }

  async envSummary(userId: string, workspaceId: string, envId: string) {
    await this.assertEnv(userId, workspaceId, envId);
    const [ers, workspace] = await Promise.all([
      this.prisma.client.envRepo.findMany({
        where: { envId },
        include: { repo: true },
      }),
      this.prisma.client.workspace.findUnique({
        where: { id: workspaceId },
        select: { allowDirectMerge: true },
      }),
    ]);
    const repos: RepoStatus[] = [];
    for (const er of ers) {
      repos.push(await this.computeStatus(er));
    }
    return {
      repos,
      allowDirectMerge: Boolean(workspace?.allowDirectMerge),
    };
  }

  private async computeStatus(er: {
    id: string;
    branch: string | null;
    baseBranch: string | null;
    envClonePath: string | null;
    envCloneStatus: string;
    repo: { name: string; url: string };
  }): Promise<RepoStatus> {
    const locator = this.parseGithubUrl(er.repo.url);
    const branchUrl =
      locator && er.branch
        ? `https://github.com/${locator.owner}/${locator.repo}/tree/${encodeURIComponent(
            er.branch
          )}`
        : null;
    const base: RepoStatus = {
      envRepoId: er.id,
      name: er.repo.name,
      branch: er.branch,
      baseBranch: er.baseBranch,
      branchUrl,
      envCloneStatus: er.envCloneStatus,
      ready: er.envCloneStatus === "ready" && Boolean(er.envClonePath),
      dirty: false,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      ahead: 0,
      behind: 0,
      hasRemote: false,
      files: [],
    };
    if (!base.ready || !er.envClonePath) return base;

    const cwd = er.envClonePath;
    const porcelain = await this.tryRun(cwd, ["status", "--porcelain=v1"]);
    if (porcelain == null) return base;

    const files: RepoStatus["files"] = [];
    for (const line of porcelain.split("\n")) {
      if (!line) continue;
      const index = line[0] ?? " ";
      const workTree = line[1] ?? " ";
      const path = line.slice(3);
      files.push({ path, index, workTree });
      if (index !== " " && index !== "?") base.staged++;
      if (workTree !== " " && workTree !== "?") base.unstaged++;
      if (index === "?" && workTree === "?") base.untracked++;
    }
    base.files = files;
    base.dirty = files.length > 0;

    // ahead/behind vs the *remote-tracking* branch so that already-pushed
    // commits don't show up as "unpushed". Order of preference:
    //   1. `@{u}` — proper upstream tracking.
    //   2. `origin/<branch>` — same-name remote branch exists (was pushed,
    //      even if tracking wasn't wired up — common when push used a URL
    //      rather than a named remote).
    //   3. `origin/<base>` — last-resort fallback so a never-pushed branch
    //      still reports its commits-vs-base count.
    const upstream = await this.tryRun(cwd, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    let compareRef: string | null = null;
    let remoteKnown = false;
    if (upstream && upstream.trim()) {
      compareRef = upstream.trim();
      remoteKnown = true;
    } else if (er.branch) {
      const sameName = await this.tryRun(cwd, [
        "rev-parse",
        "--verify",
        "-q",
        `refs/remotes/origin/${er.branch}`,
      ]);
      if (sameName && sameName.trim()) {
        compareRef = `origin/${er.branch}`;
        remoteKnown = true;
      }
    }
    if (!compareRef && er.baseBranch) {
      compareRef = `origin/${er.baseBranch}`;
    }

    if (compareRef) {
      const counts = await this.tryRun(cwd, [
        "rev-list",
        "--left-right",
        "--count",
        `${compareRef}...HEAD`,
      ]);
      if (counts) {
        const [b, a] = counts.trim().split(/\s+/).map((n) => Number(n) || 0);
        base.behind = b;
        base.ahead = a;
      }
      base.hasRemote = remoteKnown;
    }

    return base;
  }

  // ---- diff -----------------------------------------------------------

  async repoDiff(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string
  ): Promise<{ text: string; baseRef: string }> {
    await this.assertEnv(userId, workspaceId, envId);
    const er = await this.loadEnvRepo(envId, envRepoId);
    if (!er.envClonePath || er.envCloneStatus !== "ready") {
      return { text: "", baseRef: "" };
    }
    const cwd = er.envClonePath;
    const baseRef = er.baseBranch ? `origin/${er.baseBranch}` : "HEAD";
    // Only currently-uncommitted changes: working tree vs HEAD + untracked.
    // Committed-since-base lives in the History view, not the diff.
    const working =
      (await this.tryRun(cwd, ["diff", "HEAD", "--no-color"])) ?? "";
    const untracked = await this.untrackedAsDiff(cwd);
    const text = [working, untracked].filter(Boolean).join("\n");
    return { text, baseRef };
  }

  private async untrackedAsDiff(cwd: string): Promise<string> {
    const lsFiles = await this.tryRun(cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    if (!lsFiles) return "";
    const paths = lsFiles
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length === 0) return "";
    const parts: string[] = [];
    for (const p of paths) {
      const piece = await this.tryRun(cwd, [
        "diff",
        "--no-index",
        "--no-color",
        "/dev/null",
        p,
      ]);
      if (piece) parts.push(piece);
    }
    return parts.join("\n");
  }

  // ---- history --------------------------------------------------------

  async repoHistory(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string
  ): Promise<{
    commits: {
      sha: string;
      shortSha: string;
      subject: string;
      author: string;
      timestamp: number;
      url: string | null;
    }[];
  }> {
    await this.assertEnv(userId, workspaceId, envId);
    const er = await this.loadEnvRepo(envId, envRepoId);
    if (!er.envClonePath || er.envCloneStatus !== "ready" || !er.baseBranch) {
      return { commits: [] };
    }
    const cwd = er.envClonePath;
    // NUL separator between records + ASCII Unit Separator (\x1f) between
    // fields so commit subjects containing any other char pass through clean.
    const raw = await this.tryRun(cwd, [
      "log",
      `origin/${er.baseBranch}..HEAD`,
      "--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s%x00",
      "--no-color",
    ]);
    if (!raw) return { commits: [] };

    const locator = this.parseGithubUrl(er.repo.url);
    const commits = raw
      .split("\x00")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const [sha, shortSha, author, at, subject] = entry.split("\x1f");
        return {
          sha: sha ?? "",
          shortSha: shortSha ?? "",
          subject: subject ?? "",
          author: author ?? "",
          timestamp: Number(at) * 1000,
          url: locator
            ? `https://github.com/${locator.owner}/${locator.repo}/commit/${sha}`
            : null,
        };
      });
    return { commits };
  }

  // ---- commit ---------------------------------------------------------

  async commit(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string,
    message: string,
    paths?: string[]
  ) {
    await this.assertEnv(userId, workspaceId, envId);
    const er = await this.loadEnvRepo(envId, envRepoId);
    if (!er.envClonePath || er.envCloneStatus !== "ready") {
      throw new BadRequestException("Env clone not ready");
    }
    const trimmed = message.trim();
    if (!trimmed) throw new BadRequestException("Commit message required");

    const cwd = er.envClonePath;
    const safePaths = paths && paths.length > 0
      ? await this.validatePathsFromStatus(cwd, paths)
      : null;

    if (safePaths) {
      // Partial commit: stage only the requested paths (includes untracked
      // and tracked-but-deleted). `-A` scopes the stage to those paths.
      await this.run(cwd, ["add", "-A", "--", ...safePaths]);
    } else {
      await this.run(cwd, ["add", "-A"]);
    }

    const status = await this.tryRun(cwd, ["status", "--porcelain"]);
    if (!status || !status.trim()) {
      throw new BadRequestException("Nothing to commit");
    }
    await this.ensureCommitterIdentity(cwd, userId);
    if (safePaths) {
      await this.run(cwd, ["commit", "-m", trimmed, "--", ...safePaths]);
    } else {
      await this.run(cwd, ["commit", "-m", trimmed]);
    }
    const sha = (await this.run(cwd, ["rev-parse", "HEAD"])).trim();
    return { ok: true, sha };
  }

  // Only accept paths that match a real entry from `git status --porcelain`.
  // Prevents flag-injection ("-foo"), directory-escape ("../x"), or committing
  // paths the user shouldn't be able to touch via this endpoint.
  private async validatePathsFromStatus(
    cwd: string,
    requested: string[]
  ): Promise<string[]> {
    const porcelain = await this.tryRun(cwd, ["status", "--porcelain=v1"]);
    const known = new Set<string>();
    if (porcelain) {
      for (const line of porcelain.split("\n")) {
        if (!line) continue;
        known.add(line.slice(3));
      }
    }
    const out: string[] = [];
    for (const raw of requested) {
      if (typeof raw !== "string") continue;
      const p = raw.trim();
      if (!p || p.startsWith("-")) continue;
      if (known.has(p)) out.push(p);
    }
    if (out.length === 0) {
      throw new BadRequestException("No valid paths selected");
    }
    return out;
  }

  async commitAll(
    userId: string,
    workspaceId: string,
    envId: string,
    message: string
  ) {
    await this.assertEnv(userId, workspaceId, envId);
    const ers = await this.prisma.client.envRepo.findMany({
      where: { envId, envCloneStatus: "ready" },
      include: { repo: true },
    });
    const trimmed = message.trim();
    if (!trimmed) throw new BadRequestException("Commit message required");

    const results: { envRepoId: string; name: string; ok: boolean; sha?: string; error?: string }[] =
      [];
    for (const er of ers) {
      if (!er.envClonePath) {
        results.push({ envRepoId: er.id, name: er.repo.name, ok: false, error: "no env clone" });
        continue;
      }
      try {
        const cwd = er.envClonePath;
        await this.run(cwd, ["add", "-A"]);
        const status = await this.tryRun(cwd, ["status", "--porcelain"]);
        if (!status || !status.trim()) {
          results.push({ envRepoId: er.id, name: er.repo.name, ok: true });
          continue;
        }
        await this.ensureCommitterIdentity(cwd, userId);
        await this.run(cwd, ["commit", "-m", trimmed]);
        const sha = (await this.run(cwd, ["rev-parse", "HEAD"])).trim();
        results.push({ envRepoId: er.id, name: er.repo.name, ok: true, sha });
      } catch (err) {
        results.push({
          envRepoId: er.id,
          name: er.repo.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results };
  }

  private async ensureCommitterIdentity(cwd: string, userId: string) {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    const name = user?.name || user?.email?.split("@")[0] || "withvibe";
    const email = user?.email || `${userId}@withvibe.local`;
    // Local-only git identity — never overrides system config outside this repo.
    await this.tryRun(cwd, ["config", "user.name", name]);
    await this.tryRun(cwd, ["config", "user.email", email]);
  }

  // ---- push -----------------------------------------------------------

  async push(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string
  ) {
    await this.assertEnv(userId, workspaceId, envId);
    const er = await this.loadEnvRepo(envId, envRepoId);
    if (!er.envClonePath || er.envCloneStatus !== "ready" || !er.branch) {
      throw new BadRequestException("Env clone not ready");
    }
    await this.assertNotProtectedBranch(workspaceId, er.branch, er.baseBranch);
    const token = await this.workspaceGithubToken(workspaceId);
    if (!token) {
      throw new BadRequestException(
        "No GitHub token configured for this workspace"
      );
    }
    const remoteUrl = await this.run(er.envClonePath, [
      "config",
      "--get",
      "remote.origin.url",
    ]);
    const authedUrl = this.injectTokenIntoRemote(remoteUrl.trim(), token);
    if (!authedUrl) throw new BadRequestException("Unsupported remote URL");

    try {
      await this.run(er.envClonePath, [
        "push",
        "--set-upstream",
        authedUrl,
        `HEAD:refs/heads/${er.branch}`,
      ], 120_000);
      // Wire up the named-remote tracking ref so later ahead/behind checks
      // resolve via `@{u}` instead of falling back to a heuristic.
      // `push --set-upstream <URL>` points tracking at the URL string rather
      // than at `origin`, so we stamp `refs/remotes/origin/<branch>` to the
      // SHA we just pushed (HEAD) and point the local branch's upstream at
      // that named ref. No network needed. Soft-fail — a successful push
      // shouldn't turn into an error if these cleanup steps hiccup.
      const headSha = (
        await this.tryRun(er.envClonePath, ["rev-parse", "HEAD"])
      )?.trim();
      if (headSha) {
        await this.tryRun(er.envClonePath, [
          "update-ref",
          `refs/remotes/origin/${er.branch}`,
          headSha,
        ]);
        await this.tryRun(er.envClonePath, [
          "branch",
          "--set-upstream-to",
          `origin/${er.branch}`,
        ]);
      }
      return { ok: true, branch: er.branch };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Strip the token from any error message so it can't leak to the client.
      const safe = msg.replace(token, "***");
      throw new BadRequestException(`Push failed: ${safe}`);
    }
  }

  async pushAll(
    userId: string,
    workspaceId: string,
    envId: string
  ) {
    await this.assertEnv(userId, workspaceId, envId);
    const ers = await this.prisma.client.envRepo.findMany({
      where: { envId, envCloneStatus: "ready" },
      include: { repo: true },
    });
    const results: { envRepoId: string; name: string; ok: boolean; error?: string }[] = [];
    for (const er of ers) {
      try {
        await this.push(userId, workspaceId, envId, er.id);
        results.push({ envRepoId: er.id, name: er.repo.name, ok: true });
      } catch (err) {
        results.push({
          envRepoId: er.id,
          name: er.repo.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results };
  }

  // ---- pull -----------------------------------------------------------

  // The flow is built for non-technical users: every pull creates a recoverable
  // backup ref before touching anything, dirty changes are auto-stashed and
  // popped back, and any failure path returns a structured `needsAttention`
  // object with plain-English suggestedActions instead of raw git errors.
  async pull(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string,
    options: { mode?: "auto-stash" | "discard"; confirmDiscard?: boolean } = {}
  ): Promise<PullResult> {
    await this.assertEnv(userId, workspaceId, envId);
    const er = await this.loadEnvRepo(envId, envRepoId);
    return this.pullEnvRepo(userId, workspaceId, er, options);
  }

  async pullAll(
    userId: string,
    workspaceId: string,
    envId: string,
    options: { mode?: "auto-stash" | "discard"; confirmDiscard?: boolean } = {}
  ): Promise<{ results: PullResult[] }> {
    await this.assertEnv(userId, workspaceId, envId);
    const ers = await this.prisma.client.envRepo.findMany({
      where: { envId, envCloneStatus: "ready" },
      include: { repo: true, env: { select: { workspaceId: true } } },
    });
    const results: PullResult[] = [];
    // Sequential — clearer per-repo progress for non-technical users, and
    // avoids hammering the GitHub API with parallel fetches.
    for (const er of ers) {
      results.push(await this.pullEnvRepo(userId, workspaceId, er, options));
    }
    return { results };
  }

  private async pullEnvRepo(
    userId: string,
    workspaceId: string,
    er: {
      id: string;
      branch: string | null;
      baseBranch: string | null;
      envClonePath: string | null;
      envCloneStatus: string;
      repo: { name: string; url: string };
    },
    options: { mode?: "auto-stash" | "discard"; confirmDiscard?: boolean }
  ): Promise<PullResult> {
    const mode = options.mode ?? "auto-stash";
    const base: PullResult = {
      ok: false,
      envRepoId: er.id,
      name: er.repo.name,
      branch: er.branch,
      mode,
      pulledCommits: 0,
      stashed: false,
      stashRestored: false,
      backupRef: null,
    };
    if (!er.envClonePath || er.envCloneStatus !== "ready" || !er.branch) {
      return {
        ...base,
        needsAttention: {
          kind: "no-remote",
          message: "This repository isn't ready to pull yet.",
          suggestedActions: [
            {
              id: "ask-devops",
              label: "Ask DevOps agent",
              description:
                "The DevOps agent can help finish setting up this repository.",
            },
          ],
        },
      };
    }
    if (mode === "discard" && !options.confirmDiscard) {
      return {
        ...base,
        needsAttention: {
          kind: "dirty-blocked",
          message:
            "Throwing away local changes is permanent and can't be undone. Confirm the discard to proceed.",
          suggestedActions: [
            {
              id: "confirm-discard",
              label: "Yes, discard my changes",
              description:
                "Reset this repository to match GitHub exactly. Your unsaved work will be lost.",
            },
            {
              id: "cancel",
              label: "Cancel",
              description: "Keep my local changes.",
            },
          ],
        },
      };
    }

    const cwd = er.envClonePath;
    const branch = er.branch;

    const token = await this.workspaceGithubToken(workspaceId);
    if (!token) {
      return {
        ...base,
        needsAttention: {
          kind: "no-remote",
          message: "No GitHub token is configured for this workspace.",
          suggestedActions: [
            {
              id: "open-settings",
              label: "Open workspace settings",
              description: "Add a GitHub token under Workspace → Settings.",
            },
          ],
        },
      };
    }
    const remoteUrl = (
      await this.tryRun(cwd, ["config", "--get", "remote.origin.url"])
    )?.trim();
    if (!remoteUrl) {
      return {
        ...base,
        needsAttention: {
          kind: "no-remote",
          message: "This repository doesn't have a GitHub remote configured.",
          suggestedActions: [
            {
              id: "ask-devops",
              label: "Ask DevOps agent",
              description: "The DevOps agent can wire up the remote for you.",
            },
          ],
        },
      };
    }
    const authedUrl = this.injectTokenIntoRemote(remoteUrl, token);
    if (!authedUrl) {
      return {
        ...base,
        needsAttention: {
          kind: "no-remote",
          message: "The repository's remote URL isn't a recognized GitHub URL.",
          suggestedActions: [
            {
              id: "ask-devops",
              label: "Ask DevOps agent",
              description: "The DevOps agent can help fix the remote URL.",
            },
          ],
        },
      };
    }

    // Backup ref BEFORE any mutation. Lives under refs/withvibe-backup/ so it
    // doesn't pollute tag listings and is easy to clean up later.
    const headSha = (await this.tryRun(cwd, ["rev-parse", "HEAD"]))?.trim();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupRef = headSha
      ? `refs/withvibe-backup/pre-pull/${stamp}`
      : null;
    if (headSha && backupRef) {
      await this.tryRun(cwd, ["update-ref", backupRef, headSha]);
      base.backupRef = backupRef;
    }

    // Fetch into FETCH_HEAD and stamp refs/remotes/origin/<branch> so later
    // status calls resolve ahead/behind correctly.
    try {
      await this.run(
        cwd,
        ["fetch", authedUrl, `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        120_000
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const safe = msg.replace(token, "***");
      return {
        ...base,
        needsAttention: {
          kind: "no-remote",
          message: `Couldn't reach GitHub. ${safe.slice(0, 200)}`,
          suggestedActions: [
            {
              id: "retry",
              label: "Try again",
              description: "Retry the pull.",
            },
            {
              id: "ask-devops",
              label: "Ask DevOps agent",
              description: "Get help diagnosing the connection issue.",
            },
          ],
        },
      };
    }

    const remoteRef = `refs/remotes/origin/${branch}`;

    // ---- DISCARD MODE: reset to remote, drop everything ----
    if (mode === "discard") {
      try {
        await this.run(cwd, ["reset", "--hard", remoteRef]);
        await this.tryRun(cwd, ["clean", "-fd"]);
        const newHead = (
          await this.tryRun(cwd, ["rev-parse", "HEAD"])
        )?.trim();
        const pulled = await this.countCommitsBetween(cwd, headSha, newHead);
        return {
          ...base,
          ok: true,
          pulledCommits: pulled,
          notice:
            pulled > 0
              ? `Replaced your local copy with the latest from GitHub (${pulled} commit${pulled === 1 ? "" : "s"}). Local changes were discarded.`
              : "Replaced your local copy with the latest from GitHub. Local changes were discarded.",
        };
      } catch (err) {
        return {
          ...base,
          error: err instanceof Error ? err.message : String(err),
          needsAttention: {
            kind: "merge-conflict",
            message:
              "Couldn't reset this repository. The DevOps agent can take a look.",
            suggestedActions: [
              {
                id: "ask-devops",
                label: "Ask DevOps agent",
                description: "Get help recovering this repository.",
              },
            ],
          },
        };
      }
    }

    // ---- AUTO-STASH MODE ----

    // Bail out cheap if there's nothing to pull.
    const counts = await this.tryRun(cwd, [
      "rev-list",
      "--left-right",
      "--count",
      `${remoteRef}...HEAD`,
    ]);
    let behind = 0;
    let ahead = 0;
    if (counts) {
      const [b, a] = counts.trim().split(/\s+/).map((n) => Number(n) || 0);
      behind = b;
      ahead = a;
    }
    if (behind === 0) {
      return {
        ...base,
        ok: true,
        pulledCommits: 0,
        notice: "Already up to date with GitHub.",
      };
    }

    // Stash dirty/untracked changes if any, before merging.
    const dirty = (
      await this.tryRun(cwd, ["status", "--porcelain=v1"])
    )?.trim();
    let stashed = false;
    if (dirty) {
      const stashMsg = `withvibe pre-pull ${stamp}`;
      const stashOut = await this.tryRun(cwd, [
        "stash",
        "push",
        "-u",
        "-m",
        stashMsg,
      ]);
      // `git stash push` prints "No local changes to save" when there's nothing
      // worth stashing (e.g. only ignored files). Treat absence of "Saved" as
      // not-stashed so we don't try to pop nothing later.
      if (stashOut && /Saved working directory/i.test(stashOut)) {
        stashed = true;
        base.stashed = true;
      }
    }

    // Try fast-forward first; if we're diverged (ahead > 0), allow a merge
    // commit. Either way, on conflict we abort and surface needsAttention.
    let mergedCleanly = false;
    let conflictedFiles: string[] = [];
    try {
      if (ahead === 0) {
        await this.run(cwd, ["merge", "--ff-only", remoteRef]);
      } else {
        await this.ensureCommitterIdentity(cwd, userId);
        await this.run(cwd, [
          "merge",
          "--no-edit",
          "-m",
          `Merge origin/${branch} into ${branch}`,
          remoteRef,
        ]);
      }
      mergedCleanly = true;
    } catch (err) {
      // Capture conflicted files BEFORE aborting — abort wipes them.
      const unmerged = await this.tryRun(cwd, [
        "diff",
        "--name-only",
        "--diff-filter=U",
      ]);
      if (unmerged) {
        conflictedFiles = unmerged
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      await this.tryRun(cwd, ["merge", "--abort"]);
      // Restore the user's stash so they're back to where they started.
      if (stashed) {
        const popped = await this.tryRun(cwd, ["stash", "pop"]);
        base.stashRestored = popped !== null;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const safe = errMsg.replace(token, "***");
      return {
        ...base,
        error: safe.slice(0, 300),
        needsAttention: {
          kind: "merge-conflict",
          message:
            "Your local work and the changes from GitHub touch some of the same lines. Nothing was changed — the DevOps agent can help you sort this out.",
          conflictedFiles,
          suggestedActions: [
            {
              id: "ask-devops",
              label: "Ask DevOps agent",
              description:
                "Let the DevOps agent walk you through resolving the conflict.",
            },
            {
              id: "discard-local",
              label: "Throw away my changes and pull",
              description:
                "Reset this repository to match GitHub exactly. Permanent.",
            },
            {
              id: "cancel",
              label: "Cancel",
              description: "Leave this repository as it was.",
            },
          ],
        },
      };
    }

    // Pop the stash. If it conflicts, leave it alone — the user has the pulled
    // changes plus their stash to merge by hand (with DevOps agent help).
    let stashPopConflicted = false;
    if (stashed && mergedCleanly) {
      try {
        await this.run(cwd, ["stash", "pop"]);
        base.stashRestored = true;
      } catch {
        stashPopConflicted = true;
        const unmerged = await this.tryRun(cwd, [
          "diff",
          "--name-only",
          "--diff-filter=U",
        ]);
        if (unmerged) {
          conflictedFiles = unmerged
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
        }
      }
    }

    const newHead = (await this.tryRun(cwd, ["rev-parse", "HEAD"]))?.trim();
    const pulled = await this.countCommitsBetween(cwd, headSha, newHead);

    if (stashPopConflicted) {
      return {
        ...base,
        pulledCommits: pulled,
        ok: false,
        notice: `Pulled ${pulled} commit${pulled === 1 ? "" : "s"} from GitHub, but your unsaved changes need attention.`,
        needsAttention: {
          kind: "stash-pop-conflict",
          message:
            "GitHub's changes were pulled in successfully, but the unsaved changes you had touch some of the same lines. The DevOps agent can help you re-apply them.",
          conflictedFiles,
          suggestedActions: [
            {
              id: "ask-devops",
              label: "Ask DevOps agent",
              description:
                "Walk through merging your unsaved changes with the latest code.",
            },
          ],
        },
      };
    }

    const stashNote = base.stashed
      ? " We set your unsaved changes aside before pulling and put them back after."
      : "";
    return {
      ...base,
      ok: true,
      pulledCommits: pulled,
      notice: `Pulled ${pulled} commit${pulled === 1 ? "" : "s"} from GitHub.${stashNote}`,
    };
  }

  // Restore HEAD to a backup ref created by an earlier pull. Used as the
  // safety-net "undo" when a non-technical user wants to back out.
  async recoverFromBackup(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string,
    backupRef: string
  ): Promise<{ ok: boolean; restoredTo: string | null; message?: string }> {
    await this.assertEnv(userId, workspaceId, envId);
    const er = await this.loadEnvRepo(envId, envRepoId);
    if (!er.envClonePath || er.envCloneStatus !== "ready") {
      throw new BadRequestException("Env clone not ready");
    }
    // Only allow refs we created — block arbitrary input.
    if (!/^refs\/withvibe-backup\/pre-pull\/[A-Za-z0-9._-]+$/.test(backupRef)) {
      throw new BadRequestException("Invalid backup reference");
    }
    const sha = (
      await this.tryRun(er.envClonePath, ["rev-parse", "--verify", backupRef])
    )?.trim();
    if (!sha) {
      return {
        ok: false,
        restoredTo: null,
        message: "Backup point no longer exists.",
      };
    }
    try {
      await this.run(er.envClonePath, ["reset", "--hard", sha]);
      return { ok: true, restoredTo: sha };
    } catch (err) {
      throw new BadRequestException(
        `Recover failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async countCommitsBetween(
    cwd: string,
    from: string | null | undefined,
    to: string | null | undefined
  ): Promise<number> {
    if (!from || !to || from === to) return 0;
    const out = await this.tryRun(cwd, [
      "rev-list",
      "--count",
      `${from}..${to}`,
    ]);
    return out ? Number(out.trim()) || 0 : 0;
  }

  private injectTokenIntoRemote(url: string, token: string): string | null {
    if (url.startsWith("https://")) {
      // https://github.com/owner/repo.git → https://x-access-token:TOKEN@github.com/...
      return url.replace(/^https:\/\//, `https://x-access-token:${token}@`);
    }
    if (url.startsWith("git@")) {
      // SSH — convert to HTTPS-with-token so we don't depend on ssh-agent.
      const m = url.match(/^git@([^:]+):(.+)$/);
      if (!m) return null;
      const host = m[1];
      const path = m[2].replace(/^\/+/, "");
      return `https://x-access-token:${token}@${host}/${path}`;
    }
    return null;
  }

  private async workspaceGithubToken(workspaceId: string): Promise<string | null> {
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { githubToken: true },
    });
    return ws?.githubToken || process.env.GITHUB_TOKEN || null;
  }

  // ---- create PR ------------------------------------------------------

  async createPullRequest(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string,
    body: { title?: string; body?: string }
  ) {
    await this.assertEnv(userId, workspaceId, envId);
    const er = await this.loadEnvRepo(envId, envRepoId);
    if (!er.branch || !er.baseBranch) {
      throw new BadRequestException("Branch info missing");
    }
    const locator = this.parseGithubUrl(er.repo.url);
    if (!locator) {
      throw new BadRequestException("Repo URL is not a recognized GitHub URL");
    }
    const token = await this.workspaceGithubToken(workspaceId);
    if (!token) {
      throw new BadRequestException(
        "No GitHub token configured for this workspace"
      );
    }

    const title =
      (body.title || "").trim() ||
      `[withvibe] ${er.branch}`;
    const description = (body.body || "").trim();

    const res = await fetch(
      `https://api.github.com/repos/${locator.owner}/${locator.repo}/pulls`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          title,
          body: description,
          head: er.branch,
          base: er.baseBranch,
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // GitHub returns 422 if a PR already exists — surface a friendlier hint.
      if (res.status === 422 && text.includes("pull request already exists")) {
        const existing = await this.findExistingPr(
          token,
          locator,
          er.branch
        );
        if (existing) return existing;
      }
      if (res.status === 401) {
        throw new ForbiddenException(
          `GitHub rejected the token (401): ${text.slice(0, 200)}`
        );
      }
      throw new BadRequestException(
        `GitHub PR create failed (${res.status}): ${text.slice(0, 300)}`
      );
    }
    const pr = (await res.json()) as { number: number; html_url: string };
    return { number: pr.number, url: pr.html_url };
  }

  // ---- merge to base (skip PR) ---------------------------------------

  async mergeToBase(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string
  ): Promise<{ sha: string; merged: boolean; message?: string }> {
    await this.assertEnv(userId, workspaceId, envId);
    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { allowDirectMerge: true },
    });
    if (!workspace?.allowDirectMerge) {
      throw new ForbiddenException(
        "Direct merge is not enabled for this workspace"
      );
    }

    const er = await this.loadEnvRepo(envId, envRepoId);
    if (!er.branch || !er.baseBranch) {
      throw new BadRequestException("Branch info missing");
    }
    const locator = this.parseGithubUrl(er.repo.url);
    if (!locator) {
      throw new BadRequestException("Repo URL is not a recognized GitHub URL");
    }
    const token = await this.workspaceGithubToken(workspaceId);
    if (!token) {
      throw new BadRequestException(
        "No GitHub token configured for this workspace"
      );
    }

    const res = await fetch(
      `https://api.github.com/repos/${locator.owner}/${locator.repo}/merges`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          base: er.baseBranch,
          head: er.branch,
          commit_message: `Merge ${er.branch} into ${er.baseBranch}`,
        }),
      }
    );

    if (res.status === 204) {
      // Nothing to merge — the base already contains these commits.
      return { sha: "", merged: false, message: "Base already up to date" };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401) {
        throw new ForbiddenException(
          `GitHub rejected the token (401): ${text.slice(0, 200)}`
        );
      }
      if (res.status === 404) {
        throw new BadRequestException(
          `Branch not found on remote. Did you push ${er.branch}? (${text.slice(0, 200)})`
        );
      }
      if (res.status === 409) {
        throw new BadRequestException(
          `Merge conflict — this branch can't be auto-merged into ${er.baseBranch}. Resolve it via a PR. (${text.slice(0, 200)})`
        );
      }
      if (res.status === 422) {
        throw new BadRequestException(
          `GitHub refused the merge (422). This usually means a branch-protection rule on ${er.baseBranch} requires a pull request. (${text.slice(0, 300)})`
        );
      }
      throw new BadRequestException(
        `GitHub merge failed (${res.status}): ${text.slice(0, 300)}`
      );
    }
    const body = (await res.json()) as { sha: string };
    return { sha: body.sha, merged: true };
  }

  private async findExistingPr(
    token: string,
    locator: GithubLocator,
    headBranch: string
  ): Promise<{ number: number; url: string } | null> {
    const res = await fetch(
      `https://api.github.com/repos/${locator.owner}/${locator.repo}/pulls?state=open&head=${locator.owner}:${headBranch}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!res.ok) return null;
    const list = (await res.json()) as { number: number; html_url: string }[];
    if (list.length === 0) return null;
    return { number: list[0].number, url: list[0].html_url };
  }

  // ---- AI commit-message suggestion ----------------------------------

  async suggestCommitMessage(
    userId: string,
    workspaceId: string,
    envId: string,
    envRepoId: string
  ): Promise<{ message: string }> {
    const { text } = await this.repoDiff(userId, workspaceId, envId, envRepoId);
    if (!text.trim()) {
      throw new BadRequestException("No changes to summarize");
    }

    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { anthropicApiKey: true },
    });
    const apiKey = ws?.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new BadRequestException(
        "No Anthropic API key configured for this workspace"
      );
    }

    // Cap diff so we never blow past context — keep the first ~30 KB which is
    // usually the meaningful surface.
    const capped = text.length > 30_000 ? text.slice(0, 30_000) + "\n…" : text;

    const client = new Anthropic({ apiKey });
    let resp;
    try {
      resp = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        system:
          "You write concise, conventional git commit messages. Output ONLY the commit message — no preamble, no quotes, no markdown. First line ≤72 chars in conventional-commit style (feat:/fix:/refactor:/docs:/chore:). If the change is multi-faceted, add a short body after a blank line.",
        messages: [
          {
            role: "user",
            content: `Summarize this diff as a commit message:\n\n${capped}`,
          },
        ],
      });
    } catch (err) {
      // Anthropic SDK throws APIError with `status`; surface 401/403 as
      // actionable hints rather than leaking raw JSON to the toast.
      const status =
        err && typeof err === "object" && "status" in err
          ? Number((err as { status?: number }).status)
          : null;
      if (status === 401 || status === 403) {
        throw new BadRequestException(
          "Anthropic API key is invalid or unauthorized. Update it in Workspace → Settings → AI."
        );
      }
      throw new BadRequestException(
        `AI request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const block = resp.content.find((c) => c.type === "text");
    const message = block && block.type === "text" ? block.text.trim() : "";
    if (!message) throw new BadRequestException("AI returned no message");
    return { message };
  }
}
