import { promises as fs } from "node:fs";
import { run } from "../exec.js";
import { composePath, envPath } from "./paths.js";
import { log } from "./log.js";

export type ComposeArgs = {
  installDir: string;
};

// Wraps `docker compose -f <installDir>/docker-compose.yml --env-file
// <installDir>/.env <subcommand>`. Streams to the parent terminal so the
// operator sees image pulls and container output live.
export async function compose(
  installDir: string,
  args: string[],
  opts: { stream?: boolean } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const file = composePath(installDir);
  const env = envPath(installDir);
  await assertFile(file, "compose file");
  await assertFile(env, ".env");

  const baseArgs = ["compose", "-f", file, "--env-file", env, ...args];
  return run("docker", baseArgs, {
    streamTo: opts.stream === false ? "pipe" : "inherit",
    cwd: installDir,
  });
}

export type ServiceState = {
  name: string;
  state: string; // "running" | "exited" | "restarting" | ...
  health?: string; // "healthy" | "unhealthy" | "starting" | "none"
  publishers?: { url?: string; published_port?: number }[];
};

// `docker compose ps --format json` returns one JSON object per line in
// recent compose versions, an array in older ones. Handle both.
export async function composePs(installDir: string): Promise<ServiceState[]> {
  const res = await compose(installDir, ["ps", "--format", "json"], {
    stream: false,
  });
  if (res.code !== 0) {
    return [];
  }
  const trimmed = res.stdout.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as Array<Record<string, unknown>>;
      return arr.map(rowToState);
    } catch {
      return [];
    }
  }
  return trimmed
    .split("\n")
    .map((line) => {
      try {
        return rowToState(JSON.parse(line) as Record<string, unknown>);
      } catch {
        return null;
      }
    })
    .filter((x): x is ServiceState => x !== null);
}

function rowToState(row: Record<string, unknown>): ServiceState {
  return {
    name: String(row.Service ?? row.Name ?? ""),
    state: String(row.State ?? ""),
    health: row.Health ? String(row.Health) : undefined,
  };
}

async function assertFile(p: string, label: string): Promise<void> {
  try {
    await fs.access(p);
  } catch {
    log.fail(`${label} missing at ${p}. Run \`withvibe init\` first.`);
    process.exit(1);
  }
}

// Resolve API_PUBLIC_URL / WEB_PUBLIC_URL from the env file so we can poll
// them from outside the container network.
export async function readPublicUrls(
  installDir: string
): Promise<{ web?: string; api?: string }> {
  const text = await fs.readFile(envPath(installDir), "utf8").catch(() => "");
  const out: { web?: string; api?: string } = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key === "WEB_PUBLIC_URL") out.web = value;
    else if (key === "API_PUBLIC_URL") out.api = value;
  }
  return out;
}

// Poll a URL until it returns 2xx or 3xx, or timeout.
export async function waitForUrl(
  url: string,
  timeoutMs = 90_000,
  intervalMs = 1500
): Promise<{ ok: boolean; lastStatus?: number; lastError?: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | undefined;
  let lastError: string | undefined;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      lastStatus = res.status;
      if (res.status < 400) return { ok: true, lastStatus };
    } catch (e) {
      lastError = (e as Error).message;
    }
    await sleep(intervalMs);
  }
  return { ok: false, lastStatus, lastError };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
