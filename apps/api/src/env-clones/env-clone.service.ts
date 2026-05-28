import { Injectable } from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";
import { access, chmod, mkdir, rm, writeFile } from "fs/promises";
import path from "path";
import { PrismaService } from "../prisma/prisma.service";
import { ensureEnvDir, resolveRepoBaseDir } from "../common/repo-base-dir";
import { CodeWorkspaceService } from "./code-workspace.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

const exec = promisify(execFile);

/**
 * Per-env repo isolation via full local clones (one git working copy per
 * env-repo, each on its own branch).
 *
 * History: this used to use `git worktree add` from the main clone, which
 * was lighter on disk but produced a `.git` *file* (pointer back to the
 * main clone's gitdir). That broke when the path was bind-mounted into
 * a docker container or opened in some IDEs. We now make a full clone
 * via `git clone --local <mainClone> <envPath>` — hardlinks the object
 * DB on the same filesystem (so it's still cheap), but each env has a
 * real, self-contained `.git/` directory.
 *
 * Env clones live at `<REPO_BASE_DIR>/<workspaceId>/clones/<envId>/<repoName>`.
 * The path is stored on `EnvRepo.envClonePath`, so the idempotency check in
 * `ensureEnvClone` follows the DB-recorded path.
 */
@Injectable()
export class EnvCloneService {
  private get baseDir(): string {
    return resolveRepoBaseDir();
  }

  constructor(
    @InjectPinoLogger(EnvCloneService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly codeWorkspace: CodeWorkspaceService
  ) {}

  /**
   * Push a freshly-created branch to the canonical GitHub origin so it
   * exists remotely from the moment the env is created. Uses an ad-hoc
   * tokenized URL — the workspace's `githubToken` (or `GITHUB_TOKEN` env
   * var) provides auth. Best-effort: returns `{ok: false, reason}` on any
   * failure so the caller can log without aborting env creation.
   */
  private async pushNewBranchToOrigin(
    clonePath: string,
    branch: string,
    repoUrl: string,
    workspaceId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { githubToken: true },
    });
    const token = ws?.githubToken || process.env.GITHUB_TOKEN || null;
    if (!token) return { ok: false, reason: "no GitHub token configured" };

    const authedUrl = repoUrl.startsWith("https://")
      ? repoUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`)
      : null;
    if (!authedUrl) {
      return { ok: false, reason: `unsupported remote URL ${repoUrl}` };
    }

    try {
      await exec(
        "git",
        [
          "-C",
          clonePath,
          "push",
          "--set-upstream",
          authedUrl,
          `HEAD:refs/heads/${branch}`,
        ],
        { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
      );
      return { ok: true };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Strip the token before logging so it can't leak.
      return { ok: false, reason: raw.replace(token, "***") };
    }
  }

  /**
   * Install a pre-push hook in the env clone that refuses to push to the
   * env's `baseBranch` (or `main`/`master`). Catches raw `git push` from
   * inside the working dir — including pushes the AI agent might run via
   * the shell — that bypass `GitService.push()`.
   *
   * Toggleable via `Workspace.protectBaseBranch`. When disabled, the hook
   * is removed (overwritten with a no-op or deleted). Idempotent.
   *
   * Reads stdin in `pre-push` format: `<local-ref> <local-sha> <remote-ref> <remote-sha>`.
   * Exits 1 if any line targets a protected ref.
   */
  private async installPrePushHook(
    clonePath: string,
    baseBranch: string,
    enabled: boolean
  ): Promise<void> {
    const hookPath = path.join(clonePath, ".git", "hooks", "pre-push");
    if (!enabled) {
      // Best-effort removal — if the file doesn't exist, ignore.
      await rm(hookPath, { force: true }).catch(() => {});
      return;
    }
    // Build a small shell script. Quote the base branch into the script
    // by shell-escaping (the value is workspace-controlled so we keep it
    // strict — only allow [A-Za-z0-9._/-]). Anything else falls back to
    // protecting only main/master.
    const safeBase = /^[A-Za-z0-9._/-]+$/.test(baseBranch) ? baseBranch : "";
    const protectedList = ["main", "master", safeBase].filter(Boolean).join(" ");
    const script = `#!/bin/sh
# Auto-installed by withvibe EnvCloneService.
# Refuses to push to protected branches. Disable via Workspace.protectBaseBranch.
protected="${protectedList}"
while read local_ref local_sha remote_ref remote_sha; do
  for p in $protected; do
    if [ "$remote_ref" = "refs/heads/$p" ]; then
      echo "pre-push hook: refusing to push to protected branch '$p'" >&2
      exit 1
    fi
  done
done
exit 0
`;
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, script, { encoding: "utf8" });
    await chmod(hookPath, 0o755);
  }

  envBranchName(envId: string, title: string): string {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "env";
    const shortId = envId.slice(-6);
    return `env/${slug}-${shortId}`;
  }

  envClonePath(workspaceId: string, envId: string, repoName: string): string {
    return path.join(this.baseDir, workspaceId, "clones", envId, repoName);
  }

  envDir(workspaceId: string, envId: string): string {
    return path.join(this.baseDir, workspaceId, "clones", envId);
  }

  /**
   * In-flight de-duplication. If two callers race to create the same env
   * clone (e.g. background ensure on env-create + Start-env from the user),
   * the second call awaits the first's promise instead of stomping on its
   * partially-created directory.
   */
  private readonly inflight = new Map<
    string,
    Promise<{ localPath: string; branch: string } | { error: string }>
  >();

  /**
   * Ensure a per-env clone exists for this envRepo. Idempotent — safe to call
   * on every docker-up / AI-edit. Returns the clone path + branch.
   */
  async ensureEnvClone(
    envRepoId: string
  ): Promise<{ localPath: string; branch: string } | { error: string }> {
    const existing = this.inflight.get(envRepoId);
    if (existing) return existing;
    const p = this.doEnsureEnvClone(envRepoId).finally(() =>
      this.inflight.delete(envRepoId)
    );
    this.inflight.set(envRepoId, p);
    return p;
  }

  /**
   * Create the env branch off its base branch, trying progressively wider
   * sources so a non-default base branch (e.g. a prior env's `env/...`
   * branch chosen as the base) resolves even if the main-clone fetch above
   * didn't deliver it locally:
   *   1. `origin/<base>` — the remote-tracking ref copied from the main clone.
   *   2. a local `<base>` branch — for bases that exist only on disk.
   *   3. a direct `git fetch origin <base>` from the env clone's own origin
   *      (now the canonical GitHub URL, with a full `*` refspec) → FETCH_HEAD.
   * Only if all three miss do we throw — with a message that names the base
   * branch and the likely cause instead of git's opaque "is not a commit".
   */
  private async checkoutFromBase(
    clonePath: string,
    branch: string,
    baseBranch: string
  ): Promise<void> {
    const tryCheckout = async (startPoint: string): Promise<boolean> => {
      try {
        await exec(
          "git",
          ["-C", clonePath, "checkout", "-b", branch, startPoint],
          { timeout: 30_000 }
        );
        return true;
      } catch {
        return false;
      }
    };

    if (await tryCheckout(`origin/${baseBranch}`)) return;
    if (await tryCheckout(baseBranch)) return;

    // Last resort: fetch the base branch straight from origin (GitHub) into
    // this clone. A fresh `git clone` keeps the default `+refs/heads/*:...`
    // refspec, so unlike the single-branch main clone this fetch DOES create
    // the remote-tracking ref — but we also have FETCH_HEAD to fall back on.
    const fetched = await exec(
      "git",
      [
        "-C",
        clonePath,
        "fetch",
        "origin",
        `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      ],
      { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
    )
      .then(() => true)
      .catch(() => false);
    if (fetched) {
      if (await tryCheckout(`origin/${baseBranch}`)) return;
      if (await tryCheckout("FETCH_HEAD")) return;
    }

    throw new Error(
      `Base branch "${baseBranch}" could not be resolved for the env clone — ` +
        `it was not found locally or on origin. If it is another env's branch, ` +
        `make sure that env exists and its branch was pushed to origin.`
    );
  }

  private async doEnsureEnvClone(
    envRepoId: string
  ): Promise<{ localPath: string; branch: string } | { error: string }> {
    const envRepo = await this.prisma.client.envRepo.findUnique({
      where: { id: envRepoId },
      include: {
        env: { select: { id: true, title: true, workspaceId: true } },
        repo: { include: { clone: true } },
      },
    });
    if (!envRepo) return { error: "EnvRepo not found" };
    if (!envRepo.repo.clone || envRepo.repo.clone.cloneStatus !== "ready") {
      return { error: "Main clone not ready yet — wait for clone to finish" };
    }

    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: envRepo.env.workspaceId },
      select: { protectBaseBranch: true },
    });
    const protectBaseBranch = workspace?.protectBaseBranch ?? true;

    const mainClone = envRepo.repo.clone.localPath;
    const clonePath = this.envClonePath(
      envRepo.env.workspaceId,
      envRepo.env.id,
      envRepo.repo.name
    );
    const branch =
      envRepo.branch || this.envBranchName(envRepo.env.id, envRepo.env.title);
    const baseBranch =
      envRepo.baseBranch || envRepo.repo.clone.branch || "main";
    const repoUrl = envRepo.repo.url;

    // Idempotency: if the clone exists on disk and is already on the right
    // branch, nothing to do — but still re-apply the pre-push hook so a
    // toggled `protectBaseBranch` setting takes effect on the next ensure.
    try {
      await access(clonePath);
      const { stdout } = await exec(
        "git",
        ["-C", clonePath, "rev-parse", "--abbrev-ref", "HEAD"],
        { timeout: 5_000 }
      );
      if (stdout.trim() === branch) {
        await this.installPrePushHook(clonePath, baseBranch, protectBaseBranch).catch(
          (err) =>
            this.logger.warn(
              `pre-push hook refresh failed for ${clonePath}: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
        );
        return { localPath: clonePath, branch };
      }
    } catch {
      // not present — fall through to create
    }

    await this.prisma.client.envRepo.update({
      where: { id: envRepoId },
      data: {
        envCloneStatus: "creating",
        envCloneError: null,
        branch,
        baseBranch,
        envClonePath: clonePath,
      },
    });

    try {
      // path.dirname(clonePath) === envDir. Use the helper so the dir gets
      // the right ownership/setgid for the runner agent on first creation.
      await ensureEnvDir(path.dirname(clonePath));

      // Wipe any stale dir at the path (failed prior attempt, wrong branch).
      // Surface rm failures explicitly — silent failure here used to leave
      // a half-cleaned dir that broke `git clone` with a confusing
      // "destination path already exists" error.
      try {
        await rm(clonePath, { recursive: true, force: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Cannot clean stale clone at ${clonePath} (likely root-owned ` +
            `files from a running container — stop the env and retry). ` +
            `Underlying: ${msg}`
        );
      }

      // Refresh base + env branch on the main clone so the new clone inherits
      // up-to-date remote-tracking refs. Both fetches are best-effort —
      // network may be down or the env branch may not exist on origin yet.
      //
      // CRITICAL: use an EXPLICIT refspec (`+refs/heads/X:refs/remotes/origin/X`),
      // not the bare branch name. The main clone is created with `git clone
      // --depth 50`, which implies `--single-branch` — so its configured
      // `remote.origin.fetch` only matches the default branch. A bare
      // `git fetch origin <baseBranch>` for any OTHER branch (e.g. a prior
      // env's `env/...` branch picked as the base) then lands only in
      // FETCH_HEAD and never creates `refs/remotes/origin/<baseBranch>`. The
      // copy below (and the `origin/<baseBranch>` checkout) would then miss it,
      // leaving the fallback to `checkout -b <branch> <baseBranch>` against a
      // ref that doesn't exist → `fatal: '<baseBranch>' is not a commit`.
      await exec(
        "git",
        [
          "-C",
          mainClone,
          "fetch",
          "origin",
          `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
        ],
        {
          timeout: 60_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }
      ).catch(() => {});
      await exec(
        "git",
        [
          "-C",
          mainClone,
          "fetch",
          "origin",
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        {
          timeout: 60_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }
      ).catch(() => {});

      // Full local clone. `--local` hardlinks the object DB on the same
      // filesystem — fast and disk-efficient. The result has its own .git/
      // directory (no pointer file), so docker bind mounts and IDEs work
      // normally.
      await exec(
        "git",
        ["clone", "--local", mainClone, clonePath],
        { timeout: 120_000 }
      );

      // `git clone --local` only mirrors the source's *local* branches
      // (usually just `main`). The base branch the user picked may live
      // only in the main clone's `refs/remotes/origin/*` namespace — if so
      // the checkout below would fail. Copy those refs over explicitly so
      // `origin/<baseBranch>` (and any other branches we already know
      // about) exist in the env clone.
      await exec(
        "git",
        [
          "-C",
          clonePath,
          "fetch",
          mainClone,
          "+refs/remotes/origin/*:refs/remotes/origin/*",
        ],
        { timeout: 30_000 }
      ).catch(() => {});

      // Repoint origin from the local main clone to the canonical GitHub URL
      // so future fetches/pushes target GitHub. Push uses an ad-hoc
      // tokenized URL (see GitService.push), so no token in `.git/config`.
      await exec(
        "git",
        ["-C", clonePath, "remote", "set-url", "origin", repoUrl],
        { timeout: 5_000 }
      );

      // Create the env branch. Resume from `origin/<branch>` if it exists
      // (env was previously pushed and disk is being rebuilt). Otherwise
      // start fresh from `origin/<baseBranch>`.
      const { stdout: remoteEnvRef } = await exec(
        "git",
        ["-C", clonePath, "branch", "-r", "--list", `origin/${branch}`],
        { timeout: 5_000 }
      ).catch(() => ({ stdout: "" }) as { stdout: string });

      let createdFresh = false;
      if (remoteEnvRef.trim()) {
        await exec(
          "git",
          ["-C", clonePath, "checkout", "-b", branch, `origin/${branch}`],
          { timeout: 30_000 }
        );
      } else {
        createdFresh = true;
        await this.checkoutFromBase(clonePath, branch, baseBranch);
      }

      // Install the pre-push hook before any push happens so even the
      // initial push goes through the same protection path. The first
      // push targets the env branch (not the base), so the hook lets it
      // through.
      await this.installPrePushHook(clonePath, baseBranch, protectBaseBranch).catch(
        (err) =>
          this.logger.warn(
            `pre-push hook install failed for ${clonePath}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
      );

      // Push the freshly-created branch to GitHub immediately so it exists
      // remotely from day 1 (UI links work, teammates can see it). Skipped
      // for the resume case (branch already on origin) and best-effort if
      // there's no token configured — the env still works locally.
      if (createdFresh) {
        const pushed = await this.pushNewBranchToOrigin(
          clonePath,
          branch,
          repoUrl,
          envRepo.env.workspaceId
        );
        if (!pushed.ok) {
          this.logger.warn(
            `Env branch "${branch}" created locally but not pushed to origin: ${pushed.reason}`
          );
        }
      }

      await this.prisma.client.envRepo.update({
        where: { id: envRepoId },
        data: { envCloneStatus: "ready", envCloneError: null },
      });

      // Refresh the env's .code-workspace so VS Code (browser or desktop)
      // sees the new repo as a multi-root folder. Best-effort.
      void this.codeWorkspace
        .writeWorkspaceFiles(envRepo.env.id)
        .catch(() => {});

      return { localPath: clonePath, branch };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.prisma.client.envRepo.update({
        where: { id: envRepoId },
        data: { envCloneStatus: "error", envCloneError: msg.slice(0, 500) },
      });
      return { error: msg };
    }
  }

  async removeEnvClone(
    envRepoId: string,
    options: { deleteRemoteBranch?: boolean } = {}
  ): Promise<void> {
    const envRepo = await this.prisma.client.envRepo.findUnique({
      where: { id: envRepoId },
      include: { repo: { include: { clone: true } } },
    });
    if (!envRepo) return;

    const envIdForRefresh = envRepo.envId;
    const mainClone = envRepo.repo.clone?.localPath;
    const clonePath = envRepo.envClonePath;
    const branch = envRepo.branch;

    if (clonePath) {
      await rm(clonePath, { recursive: true, force: true }).catch(() => {});
    }
    if (mainClone && branch) {
      await exec("git", ["-C", mainClone, "branch", "-D", branch], {
        timeout: 10_000,
      }).catch(() => {});
    }

    // Opt-in: remove the branch on origin too. Default off because branches
    // are sometimes useful as a record after the env itself is gone (open
    // PRs, partial work the user wants to revisit). Failures here are
    // logged and swallowed — local cleanup already succeeded, and "remote
    // ref does not exist" is the expected outcome if the branch was never
    // pushed or was already deleted elsewhere.
    if (options.deleteRemoteBranch && branch && mainClone) {
      try {
        await exec(
          "git",
          ["-C", mainClone, "push", "origin", "--delete", branch],
          { timeout: 20_000 }
        );
        this.logger.info(
          `Deleted remote branch "${branch}" on origin (envRepo ${envRepoId}).`
        );
      } catch (err) {
        // execFile rejects with an Error carrying `stderr` on non-zero exit.
        const stderr =
          (err as { stderr?: string } | null)?.stderr ??
          (err instanceof Error ? err.message : String(err));
        if (/remote ref does not exist/i.test(stderr)) {
          this.logger.info(
            `Remote branch "${branch}" was already gone — nothing to delete on origin.`
          );
        } else {
          this.logger.warn(
            `Failed to delete remote branch "${branch}" for envRepo ${envRepoId}: ${stderr.trim() || "unknown error"}`
          );
        }
      }
    }

    // Drop the removed repo from the .code-workspace so VS Code stops
    // showing a missing folder. Best-effort.
    void this.codeWorkspace
      .writeWorkspaceFiles(envIdForRefresh)
      .catch(() => {});
  }

  async removeEnvClones(
    envId: string,
    options: { deleteRemoteBranch?: boolean } = {}
  ): Promise<void> {
    const envRepos = await this.prisma.client.envRepo.findMany({
      where: { envId },
    });
    for (const er of envRepos) {
      await this.removeEnvClone(er.id, options);
    }
  }
}
