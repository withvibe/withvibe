/**
 * Self-check for the git execution targets. This repo has no test runner, so
 * (matching check:fargate-reaper) this is a ts-node script:
 *
 *   pnpm --filter @withvibe/api check:git-exec
 *
 * GitService has one code path for thirteen endpoints, and it works only
 * because both targets behave identically: resolve with stdout, or reject with
 * git's stderr. tryRun turns a rejection into "not available" — so a sandbox
 * target that resolved where the host target would have thrown would make a
 * failed command look like a clean repository, and a failed push look like a
 * successful one.
 *
 * Exits non-zero on any unexpected outcome.
 */
import { execFile } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { PassThrough } from "stream";
import { EventEmitter } from "events";
import { promisify } from "util";
import {
  HostGitTarget,
  SandboxGitTarget,
  sandboxRepoPath,
  type GitRepoTarget,
  type SandboxExec,
} from "./git-exec";

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

type FakeRun = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** Emit nothing and never close, to exercise the timeout. */
  hang?: boolean;
  /** Fail before the process exists at all. */
  spawnError?: string;
};

const calls: { argv: string[]; env?: Record<string, string>; cwd?: string }[] = [];
let killed = 0;

function fakeExec(script: FakeRun): SandboxExec {
  return (job) => {
    calls.push(job);
    if (script.spawnError) return Promise.reject(new Error(script.spawnError));
    const stdout = new PassThrough({ encoding: "utf-8" });
    const stderr = new PassThrough({ encoding: "utf-8" });
    const events = new EventEmitter();
    const handle = {
      stdout,
      stderr,
      exitCode: null as number | null,
      kill: () => {
        killed++;
      },
      on: (event: "error" | "close", cb: (...args: unknown[]) => void) => {
        events.on(event, cb);
      },
    };
    if (!script.hang) {
      setImmediate(() => {
        if (script.stdout) stdout.write(script.stdout);
        if (script.stderr) stderr.write(script.stderr);
        handle.exitCode = script.exitCode ?? 0;
        events.emit("close");
      });
    }
    return Promise.resolve(handle);
  };
}

async function settle(p: Promise<string>): Promise<
  { ok: true; value: string } | { ok: false; message: string }
> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  expect("sandbox repos resolve under /workspace", sandboxRepoPath("app") === "/workspace/app");

  // ---- the sandbox target in isolation -----------------------------------

  {
    calls.length = 0;
    const t = new SandboxGitTarget("/workspace/app", fakeExec({ stdout: "on main\n" }), {
      GIT_CONFIG_COUNT: "1",
    });
    const r = await settle(t.run(["status", "--porcelain"]));
    expect("a clean exit resolves with stdout", r.ok && r.value === "on main\n");
    expect(
      "the command is addressed at the repo with -C",
      JSON.stringify(calls[0]?.argv) ===
        JSON.stringify(["git", "-C", "/workspace/app", "status", "--porcelain"])
    );
    expect(
      "the per-user git config is passed to the command",
      calls[0]?.env?.GIT_CONFIG_COUNT === "1"
    );
  }

  {
    const t = new SandboxGitTarget(
      "/workspace/app",
      fakeExec({ stderr: "fatal: not a git repository\n", exitCode: 128 }),
      {}
    );
    const r = await settle(t.run(["status"]));
    expect("a non-zero exit rejects", !r.ok);
    expect(
      "the rejection carries git's stderr",
      !r.ok && r.message.includes("not a git repository")
    );
  }

  {
    // Some git failures write only to stdout; rejecting with an empty message
    // would leave the user with nothing to act on.
    const t = new SandboxGitTarget(
      "/workspace/app",
      fakeExec({ stdout: "! [rejected] main -> main\n", exitCode: 1 }),
      {}
    );
    const r = await settle(t.run(["push"]));
    expect(
      "a failure with empty stderr still rejects with something readable",
      !r.ok && r.message.includes("rejected")
    );
  }

  {
    const t = new SandboxGitTarget("/workspace/app", fakeExec({ spawnError: "bridge unreachable" }), {});
    const r = await settle(t.run(["status"]));
    expect(
      "an unreachable sandbox rejects rather than hanging",
      !r.ok && r.message.includes("bridge unreachable")
    );
  }

  {
    const before = killed;
    const t = new SandboxGitTarget("/workspace/app", fakeExec({ hang: true }), {});
    const r = await settle(t.run(["fetch"], { timeoutMs: 150 }));
    expect("a command that never finishes rejects on timeout", !r.ok && r.message.includes("timed out"));
    expect("the timed-out command is killed, not left running", killed > before);
  }

  // ---- both targets must fail the same way -------------------------------

  const root = await mkdtemp(path.join(tmpdir(), "wv-git-exec-"));
  try {
    const repo = path.join(root, "repo");
    await exec("git", ["init", "-q", "-b", "main", repo]);
    await writeFile(path.join(repo, "a.txt"), "hello\n");

    const host: GitRepoTarget = new HostGitTarget(repo);
    const hostOk = await settle(host.run(["status", "--porcelain"]));
    expect(
      "the host target resolves with stdout",
      hostOk.ok && hostOk.value.includes("a.txt")
    );

    const hostBad = await settle(host.run(["rev-parse", "--verify", "no-such-ref"]));
    expect("the host target rejects on a failing command", !hostBad.ok);

    // The contract GitService.tryRun depends on, checked across both.
    const notARepo = new HostGitTarget(path.join(root, "nothing-here"));
    const sandboxNotARepo = new SandboxGitTarget(
      "/workspace/nothing-here",
      fakeExec({ stderr: "fatal: cannot change to '/workspace/nothing-here'\n", exitCode: 128 }),
      {}
    );
    const a = await settle(notARepo.run(["status"]));
    const b = await settle(sandboxNotARepo.run(["status"]));
    expect(
      "a missing repository rejects on both targets, never resolves on either",
      !a.ok && !b.ok,
      `host=${a.ok ? "resolved" : "rejected"} sandbox=${b.ok ? "resolved" : "rejected"}`
    );

    // Same for a command that succeeds: both resolve with the raw stdout, so
    // every parser in GitService sees the same bytes either way.
    await exec("git", ["-C", repo, "add", "."]);
    await exec("git", [
      "-C", repo, "-c", "user.name=t", "-c", "user.email=t@e.com",
      "commit", "-qm", "one",
    ]);
    const hostLog = await settle(host.run(["log", "--pretty=%s"]));
    const sandboxLog = await settle(
      new SandboxGitTarget("/workspace/repo", fakeExec({ stdout: "one\n" }), {}).run([
        "log",
        "--pretty=%s",
      ])
    );
    expect(
      "identical output comes back identically from both targets",
      hostOk.ok && hostLog.ok && sandboxLog.ok && hostLog.value === sandboxLog.value,
      hostLog.ok ? JSON.stringify(hostLog.value) : "host rejected"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main()
  .catch((err) => {
    fail++;
    console.log(`FAIL  checks threw — ${err instanceof Error ? err.message : String(err)}`);
  })
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  });
