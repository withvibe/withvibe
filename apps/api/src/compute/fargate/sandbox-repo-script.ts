/**
 * The shell script that materialises an env's repositories inside its sandbox.
 *
 * On a local env the platform clones repos on the host and bind-mounts them in.
 * A Fargate task has no host to mount from, so the clone has to happen inside
 * the task — against the git proxy, which is what keeps the GitHub credential
 * out of the client's cloud entirely (see git-proxy/).
 *
 * Built as a script rather than a sequence of exec calls because the bridge
 * charges a round trip per call and a four-repo env would otherwise mean
 * dozens. Built as a *string* rather than a file because there is no shared
 * filesystem to put a file on.
 *
 * It must be idempotent. `/workspace` lives on EFS and survives stops, so on
 * the second start the repos are already there — and an env that is stopped
 * and restarted mid-task must come back with its work intact, never reset to
 * a fresh clone. The script therefore repairs what it finds instead of
 * replacing it, and never discards a working tree it did not create.
 *
 * It contains no secrets. The proxy credential arrives through GIT_CONFIG_*
 * in the process environment, so nothing sensitive is ever written to disk or
 * captured in a log line.
 */

export type SandboxRepo = {
  /** Directory name under /workspace. */
  name: string;
  /** Git proxy URL for this repo. */
  remote: string;
  /** Branch the env works on. */
  branch: string;
  /** Branch the env branch is created from when it does not exist yet. */
  baseBranch: string;
};

export type Committer = {
  name: string;
  email: string;
};

export const SANDBOX_WORKSPACE_DIR = "/workspace";

/** Names become directory names and git arguments; keep them boring. */
const SAFE_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
/** Git refuses weirder branch names anyway; rejecting early gives a clearer error. */
const SAFE_REF_RE = /^[A-Za-z0-9._\-/]{1,200}$/;

export class SandboxRepoScriptError extends Error {}

/** POSIX single-quoting: safe for every byte except the quote itself. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildRepoBootstrapScript(
  repos: SandboxRepo[],
  committer: Committer
): string {
  for (const repo of repos) {
    if (!SAFE_NAME_RE.test(repo.name)) {
      throw new SandboxRepoScriptError(`unsafe repository name: ${repo.name}`);
    }
    if (!SAFE_REF_RE.test(repo.branch) || repo.branch.startsWith("-")) {
      throw new SandboxRepoScriptError(`unsafe branch name: ${repo.branch}`);
    }
    if (!SAFE_REF_RE.test(repo.baseBranch) || repo.baseBranch.startsWith("-")) {
      throw new SandboxRepoScriptError(`unsafe base branch name: ${repo.baseBranch}`);
    }
  }

  const q = shellQuote;
  const lines: string[] = [
    "set -u",
    "failed=0",
    `mkdir -p ${q(SANDBOX_WORKSPACE_DIR)}`,
    // Every repo lives on an EFS mount owned by uid 0 via the access point,
    // while git's ownership check compares against the running user. Marking
    // the tree safe up front avoids a "dubious ownership" failure that reads
    // like a permissions bug and isn't one.
    `git config --global --replace-all safe.directory '*' 2>/dev/null || true`,
    "",
    "setup_repo() {",
    '  name="$1"; remote="$2"; branch="$3"; base="$4"',
    `  dir=${q(SANDBOX_WORKSPACE_DIR)}/"$name"`,
    '  if [ -d "$dir/.git" ]; then',
    '    echo "[repo] $name: already present, updating"',
    // The remote carries the env id, and an env that was rebuilt gets a new
    // token prefix — so re-point it every time rather than trusting what the
    // previous start wrote.
    '    git -C "$dir" remote set-url origin "$remote" || return 1',
    "  else",
    '    echo "[repo] $name: cloning"',
    // Only ever remove a path that is NOT a git repository: a leftover from a
    // clone that died halfway. Anything with a .git took the branch above.
    '    rm -rf "$dir"',
    '    git clone "$remote" "$dir" || return 1',
    "  fi",
    `  git -C "$dir" config user.name ${q(committer.name)}`,
    `  git -C "$dir" config user.email ${q(committer.email)}`,
    '  git -C "$dir" fetch --prune origin || return 1',
    // Three ways to end up on the env branch, in order of how much they
    // preserve: work already here, work pushed from a previous task, or a
    // branch that does not exist yet.
    '  if git -C "$dir" show-ref --verify --quiet "refs/heads/$branch"; then',
    '    git -C "$dir" checkout "$branch" || return 1',
    '  elif git -C "$dir" show-ref --verify --quiet "refs/remotes/origin/$branch"; then',
    '    git -C "$dir" checkout -b "$branch" "origin/$branch" || return 1',
    '  elif git -C "$dir" show-ref --verify --quiet "refs/remotes/origin/$base"; then',
    '    git -C "$dir" checkout -b "$branch" "origin/$base" || return 1',
    "  else",
    '    echo "[repo] $name: base branch $base not found on origin" >&2',
    "    return 1",
    "  fi",
    '  head=$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo unknown)',
    '  echo "[repo] $name: on $branch at $head"',
    "}",
    "",
  ];

  for (const repo of repos) {
    lines.push(
      `setup_repo ${q(repo.name)} ${q(repo.remote)} ${q(repo.branch)} ${q(
        repo.baseBranch
      )} || { echo "[repo] ${repo.name}: FAILED" >&2; failed=$((failed+1)); }`
    );
  }

  lines.push(
    "",
    // A repo that fails to clone is reported but must not take the sandbox
    // down with it — the rest of the environment is still usable, and the
    // error is more useful in front of someone than as a failed start.
    'if [ "$failed" -gt 0 ]; then echo "[repo] $failed repository/repositories failed" >&2; fi',
    "exit 0"
  );
  return lines.join("\n");
}
