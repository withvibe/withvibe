import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

/**
 * Where an env's repository actually lives, and how to run git against it.
 *
 * Local envs keep their clones on the platform host and bind-mount them into
 * the containers, so git runs here. Fargate envs clone inside the task (see
 * SandboxReposService) — there is no host copy at all, and deliberately so:
 * the whole point of running the sandbox in the client's own account is that
 * the platform does not hold a working copy of their source.
 *
 * That difference is the only thing the git panel needs to care about, because
 * every operation in GitService — status, diff, history, commit, push, pull,
 * merge, recover — is a `git -C <dir> ...` and nothing else. So instead of two
 * implementations of thirteen endpoints, there are two implementations of one
 * method, and the endpoints are written once.
 *
 * Both must fail the same way: reject with an Error whose message carries
 * git's stderr. GitService.tryRun turns a rejection into "this isn't
 * available", and a sandbox target that resolved quietly instead of throwing
 * would make a broken repo look like a clean one.
 */
export interface GitRepoTarget {
  /** Which filesystem the repo is on — only push/pull credentialing cares. */
  readonly kind: "host" | "sandbox";
  /** Repository directory, in whichever filesystem this target addresses. */
  readonly cwd: string;
  run(args: string[], opts?: { timeoutMs?: number }): Promise<string>;
}

/** 50 MB: big diffs are normal, and truncating one silently is worse than failing. */
const MAX_BUFFER = 50 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class HostGitTarget implements GitRepoTarget {
  readonly kind = "host" as const;

  constructor(readonly cwd: string) {}

  async run(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
    const { stdout } = await exec("git", ["-C", this.cwd, ...args], {
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  }
}

/** What the sandbox target needs from the exec bridge, named so this module
 * does not have to depend on the Fargate driver's shape. */
export type SandboxExec = (job: {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
}) => Promise<{
  stdout: NodeJS.EventEmitter;
  stderr: NodeJS.EventEmitter;
  exitCode: number | null;
  kill(): void;
  on(event: "error" | "close", cb: (...args: unknown[]) => void): void;
}>;

export class SandboxGitTarget implements GitRepoTarget {
  readonly kind = "sandbox" as const;

  constructor(
    readonly cwd: string,
    private readonly exec: SandboxExec,
    /**
     * Git configuration handed to every command — in practice the proxy
     * credential for the person who asked. Passed per call rather than relying
     * on the container's own environment, so a push through the git panel is
     * attributed to whoever clicked it, not to whoever happened to start the
     * env.
     */
    private readonly env: Record<string, string>
  ) {}

  run(args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(stdout);
      };

      const timer = setTimeout(() => {
        handle?.kill();
        finish(new Error(`git ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let handle: Awaited<ReturnType<SandboxExec>> | null = null;
      void this.exec({
        argv: ["git", "-C", this.cwd, ...args],
        cwd: this.cwd,
        env: this.env,
      })
        .then((h) => {
          handle = h;
          h.stdout.on("data", (chunk: string) => {
            stdout += chunk;
            if (stdout.length > MAX_BUFFER) {
              h.kill();
              finish(new Error("git output exceeded the maximum buffer size"));
            }
          });
          h.stderr.on("data", (chunk: string) => (stderr += chunk));
          h.on("error", (err) =>
            finish(err instanceof Error ? err : new Error(String(err)))
          );
          h.on("close", () => {
            // Mirror execFile: a non-zero exit is a rejection carrying stderr,
            // because that is what every caller's error handling expects.
            if (h.exitCode === 0) finish(null);
            else {
              finish(
                new Error(
                  stderr.trim() ||
                    stdout.trim() ||
                    `git exited with code ${h.exitCode ?? "unknown"}`
                )
              );
            }
          });
        })
        .catch((err: unknown) =>
          finish(err instanceof Error ? err : new Error(String(err)))
        );
    });
  }
}

/** Where SandboxReposService puts an env's repositories inside the task. */
export function sandboxRepoPath(repoName: string): string {
  return `/workspace/${repoName}`;
}
