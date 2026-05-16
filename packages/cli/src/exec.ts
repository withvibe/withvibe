import { spawn, type SpawnOptions } from "node:child_process";

export type RunResult = {
  stdout: string;
  stderr: string;
  code: number;
};

// Wrapper over spawn that returns a promise, forwards signals, and optionally
// streams stdio to the current terminal (for long-running commands like git
// clone or docker compose up where the user wants to see live progress).
export function run(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { streamTo?: "inherit" | "pipe" } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stream = opts.streamTo ?? "pipe";
    const child = spawn(cmd, args, {
      stdio: stream === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
      ...opts,
    });

    let stdout = "";
    let stderr = "";

    if (stream === "pipe") {
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    }

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export async function which(cmd: string): Promise<boolean> {
  const finder = process.platform === "win32" ? "where" : "which";
  const res = await run(finder, [cmd]).catch(() => ({ code: 1 } as RunResult));
  return res.code === 0;
}

export async function captureVersion(
  cmd: string,
  args: string[]
): Promise<string | null> {
  const res = await run(cmd, args).catch(() => null);
  if (!res || res.code !== 0) return null;
  return (res.stdout || res.stderr).trim().split("\n")[0] ?? null;
}
