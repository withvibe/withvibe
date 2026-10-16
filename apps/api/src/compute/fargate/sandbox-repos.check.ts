/**
 * Self-check for the in-sandbox repository bootstrap script. This repo has no
 * test runner, so (matching check:fargate-reaper) this is a ts-node script:
 *
 *   pnpm --filter @withvibe/api check:sandbox-repos
 *
 * The script runs as root inside the sandbox with the env's git credential in
 * its environment, and its arguments come from database rows. Two things
 * therefore matter more than anything else here: that nothing in a repo name
 * or branch name can break out of its quoting, and that a second start never
 * destroys the work a first one left behind.
 *
 * Exits non-zero on any unexpected outcome.
 */
import { execFile } from "child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import {
  buildRepoBootstrapScript,
  shellQuote,
  SandboxRepoScriptError,
  type SandboxRepo,
} from "./sandbox-repo-script";

const exec = promisify(execFile);

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const COMMITTER = { name: "Yariv Tester", email: "yariv@example.com" };
const repo = (over: Partial<SandboxRepo> = {}): SandboxRepo => ({
  name: "app",
  remote: "https://api.example.com/api/git-proxy/env1/app",
  branch: "env/feature-abc123",
  baseBranch: "main",
  ...over,
});

// ---- quoting -------------------------------------------------------------

{
  expect("plain values are quoted", shellQuote("abc") === "'abc'");
  expect(
    "embedded single quotes cannot close the quoting",
    shellQuote("it's") === `'it'\\''s'`
  );
  // The payloads that matter: anything that would otherwise reach the shell.
  for (const nasty of ["a; rm -rf /", "$(id)", "`id`", "a\nb", "--upload-pack=x"]) {
    const quoted = shellQuote(nasty);
    expect(
      `quoting neutralises ${JSON.stringify(nasty)}`,
      quoted.startsWith("'") && quoted.endsWith("'") && !quoted.slice(1, -1).includes("'")
    );
  }
}

// ---- input validation ----------------------------------------------------

function refuses(label: string, over: Partial<SandboxRepo>) {
  let threw = false;
  try {
    buildRepoBootstrapScript([repo(over)], COMMITTER);
  } catch (err) {
    threw = err instanceof SandboxRepoScriptError;
  }
  expect(label, threw);
}

refuses("a repo name with a slash is refused", { name: "../../etc" });
refuses("a repo name with a space is refused", { name: "my repo" });
refuses("a repo name with a semicolon is refused", { name: "app;id" });
refuses("an empty repo name is refused", { name: "" });
refuses("a branch starting with a dash is refused", { branch: "--upload-pack=evil" });
refuses("a branch with a shell metacharacter is refused", { branch: "env/$(id)" });
refuses("a base branch starting with a dash is refused", { baseBranch: "-x" });

{
  // A committer name is free text from a user profile and is NOT validated —
  // quoting has to carry it. If that ever stops being true, this fails.
  const script = buildRepoBootstrapScript([repo()], {
    name: "O'Brien; rm -rf /",
    email: "o@example.com",
  });
  expect(
    "a hostile committer name survives as data, not code",
    script.includes(`'O'\\''Brien; rm -rf /'`)
  );
}

// ---- shape ---------------------------------------------------------------

{
  const script = buildRepoBootstrapScript(
    [repo({ name: "app" }), repo({ name: "api", branch: "env/other-x1" })],
    COMMITTER
  );
  expect("every repo gets a setup call", (script.match(/^setup_repo /gm) ?? []).length === 2);
  expect(
    "a failing repo does not abort the others",
    script.includes("failed=$((failed+1))") && script.includes("exit 0")
  );
  expect(
    "the script never contains a credential",
    !script.includes("Authorization") && !script.includes("wvg1.")
  );
  expect("no repos means no setup calls", !buildRepoBootstrapScript([], COMMITTER).includes("setup_repo "));
}

// ---- behaviour, against real git ----------------------------------------

/**
 * Run the real script against a real git remote on disk. This is the part
 * worth having: the branching logic is three nested shell conditionals whose
 * failure mode is destroying someone's uncommitted work, and no amount of
 * string-matching the script proves it does the right thing.
 */
async function behaviourChecks() {
  const root = await mkdtemp(path.join(tmpdir(), "wv-sandbox-repos-"));
  const git = (cwd: string, ...args: string[]) =>
    exec("git", ["-C", cwd, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e.com",
      },
    });

  try {
    // An origin the script can clone from, with a `main` holding one commit.
    const origin = path.join(root, "origin.git");
    const seed = path.join(root, "seed");
    await mkdir(seed, { recursive: true });
    await exec("git", ["init", "-q", "-b", "main", seed]);
    await writeFile(path.join(seed, "README.md"), "seed\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-qm", "seed");
    await exec("git", ["clone", "-q", "--bare", seed, origin]);

    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    /** Output only — the common case, where every repo is best-effort. */
    const run = async (repos: SandboxRepo[]) => (await runWithExit(repos)).output;

    /**
     * Output plus exit code. The exit code is the contract the init container
     * depends on: ECS starts the services that mount a repo only when this
     * script exits zero.
     */
    const runWithExit = async (
      repos: SandboxRepo[],
      requiredRepos: string[] = []
    ): Promise<{ output: string; exitCode: number }> => {
      const script = buildRepoBootstrapScript(repos, COMMITTER, requiredRepos)
        // The script hardcodes /workspace; point it at the sandbox we can write.
        .split("'/workspace'")
        .join(shellQuote(workspace));
      try {
        const { stdout, stderr } = await exec("sh", ["-c", script], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", HOME: root },
          maxBuffer: 10 * 1024 * 1024,
        });
        return { output: `${stdout}${stderr}`, exitCode: 0 };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          output: `${e.stdout ?? ""}${e.stderr ?? ""}`,
          exitCode: typeof e.code === "number" ? e.code : -1,
        };
      }
    };

    const spec = repo({ name: "app", remote: origin, branch: "env/work-abc", baseBranch: "main" });
    const clone = path.join(workspace, "app");

    // First start: nothing on the volume yet.
    const first = await run([spec]);
    expect("a first start clones the repo", first.includes("cloning"));
    const branch = (await git(clone, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    expect("the env branch is created off the base branch", branch === "env/work-abc", branch);
    const who = (await git(clone, "config", "user.email")).stdout.trim();
    expect("the committer identity is set on the clone", who === COMMITTER.email, who);

    // The case that must never regress: a restart with uncommitted work.
    await writeFile(path.join(clone, "WORK.txt"), "uncommitted work\n");
    await writeFile(path.join(clone, "README.md"), "edited\n");
    const second = await run([spec]);
    expect("a second start reuses the existing checkout", second.includes("already present"));
    expect(
      "uncommitted work survives a restart",
      (await readFile(path.join(clone, "WORK.txt"), "utf-8")).trim() === "uncommitted work"
    );
    expect(
      "edits to tracked files survive a restart",
      (await readFile(path.join(clone, "README.md"), "utf-8")).trim() === "edited"
    );
    expect(
      "the restart stays on the env branch",
      (await git(clone, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim() === "env/work-abc"
    );

    // A branch that exists on origin but not locally — the "someone else
    // pushed this env's branch" case, and what a rebuilt task sees.
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "work from the sandbox");
    await git(clone, "push", "-q", "origin", "env/work-abc");
    await rm(clone, { recursive: true, force: true });
    const third = await run([spec]);
    expect("a wiped volume re-clones", third.includes("cloning"));
    expect(
      "an env branch already on origin is checked out, not recreated from base",
      (await git(clone, "log", "-1", "--pretty=%s")).stdout.trim() === "work from the sandbox"
    );

    // ---- the directory inode must survive a clone -------------------------
    // An EFS access point creates its root directory when it is created, and
    // Fargate mounts every task volume before any container runs — so by the
    // time this script executes, a repo a compose service mounts is already an
    // empty, mounted directory. Replacing it (rm -rf + git clone) gives it a
    // new inode and leaves that mount pointing at a dead one; the service then
    // fails to start with "stale file handle", reported against whatever
    // mountpoint it tried to create next. Cloning in place is the only version
    // of this that works.
    const mounted = path.join(workspace, "mounted");
    await mkdir(mounted, { recursive: true });
    const inodeOf = async (p: string) =>
      (await exec("ls", ["-di", p])).stdout.trim().split(/\s+/)[0];
    const inodeBefore = await inodeOf(mounted);
    const intoMounted = await runWithExit(
      [repo({ name: "mounted", remote: origin, branch: "env/m", baseBranch: "main" })],
      ["mounted"]
    );
    expect(
      "a pre-created empty directory is cloned into, not replaced",
      intoMounted.exitCode === 0 && intoMounted.output.includes("[repo] mounted: on env/m"),
      `exit=${intoMounted.exitCode} ${intoMounted.output}`
    );
    expect(
      "and keeps its inode, so a mount of it does not go stale",
      (await inodeOf(mounted)) === inodeBefore,
      `${inodeBefore} -> ${await inodeOf(mounted)}`
    );
    expect(
      "the clone really landed in that same directory",
      (await readFile(path.join(mounted, "README.md"), "utf-8")).trim() === "seed"
    );

    // Same for a directory holding junk from a clone that died halfway: the
    // contents go, the directory does not.
    const halfway = path.join(workspace, "halfway");
    await mkdir(halfway, { recursive: true });
    await writeFile(path.join(halfway, "stale-junk.txt"), "left over\n");
    const halfwayInode = await inodeOf(halfway);
    const recovered = await runWithExit([
      repo({ name: "halfway", remote: origin, branch: "env/h", baseBranch: "main" }),
    ]);
    expect(
      "a half-written directory is recovered in place",
      recovered.exitCode === 0 &&
        (await inodeOf(halfway)) === halfwayInode &&
        recovered.output.includes("[repo] halfway: on env/h"),
      `exit=${recovered.exitCode} ${recovered.output}`
    );

    // A base branch that does not exist is reported, not silently ignored.
    const bad = await run([
      repo({ name: "nope", remote: origin, branch: "env/x", baseBranch: "no-such-branch" }),
    ]);
    expect("a missing base branch is reported as a failure", bad.includes("FAILED"));
    expect(
      "a failing repo still lets the script exit cleanly",
      bad.includes("1 repository/repositories failed")
    );

    // Two repos, one broken: the good one must still land.
    const mixed = await run([
      repo({ name: "good", remote: origin, branch: "env/y", baseBranch: "main" }),
      repo({ name: "bad", remote: origin, branch: "env/y", baseBranch: "missing" }),
    ]);
    expect("a broken repo does not stop a healthy one", mixed.includes("[repo] good: on env/y"));

    // ---- required repos: the init container's exit-code contract ----------
    // A repo a compose service bind-mounts cannot be best-effort. The service
    // depends on this script exiting zero, so a failure here has to be fatal —
    // otherwise the container starts on an empty directory and fails in a way
    // that no longer mentions git at all.

    const requiredOk = await runWithExit(
      [repo({ name: "mounted", remote: origin, branch: "env/z", baseBranch: "main" })],
      ["mounted"]
    );
    expect(
      "a required repo that clones exits zero",
      requiredOk.exitCode === 0 && requiredOk.output.includes("[repo] mounted: on env/z"),
      `exit=${requiredOk.exitCode} ${requiredOk.output}`
    );

    const requiredBad = await runWithExit(
      [repo({ name: "mounted2", remote: origin, branch: "env/z", baseBranch: "missing" })],
      ["mounted2"]
    );
    expect(
      "a required repo that fails exits non-zero",
      requiredBad.exitCode !== 0,
      `exit=${requiredBad.exitCode}`
    );
    expect(
      "and says why the env will not start",
      requiredBad.output.includes("mounted by a service"),
      requiredBad.output
    );

    // The distinction has to hold both ways round, or marking repos required
    // would just make every clone failure fatal.
    const optionalBad = await runWithExit(
      [
        repo({ name: "mountedok", remote: origin, branch: "env/z", baseBranch: "main" }),
        repo({ name: "sidecar", remote: origin, branch: "env/z", baseBranch: "missing" }),
      ],
      ["mountedok"]
    );
    expect(
      "a non-required repo failing alongside a required one stays non-fatal",
      optionalBad.exitCode === 0 && optionalBad.output.includes("[repo] sidecar: FAILED"),
      `exit=${optionalBad.exitCode} ${optionalBad.output}`
    );

    // A mount naming a repo the env does not have is a translation bug, not a
    // runtime one — catch it while building the script, not in the sandbox.
    let threw = false;
    try {
      buildRepoBootstrapScript(
        [repo({ name: "app", remote: origin, branch: "env/z", baseBranch: "main" })],
        COMMITTER,
        ["absent"]
      );
    } catch {
      threw = true;
    }
    expect("a required repo that is not attached is refused up front", threw);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void behaviourChecks()
  .catch((err) => {
    fail++;
    console.log(`FAIL  behaviour checks threw — ${err instanceof Error ? err.message : String(err)}`);
  })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  });
