import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { captureVersion, run, which } from "../exec.js";
import { log } from "./log.js";

export type CheckResult = {
  name: string;
  ok: boolean;
  detail?: string;
  fix?: string;
};

export type DoctorReport = {
  ok: boolean;
  results: CheckResult[];
};

const REQUIRED_PORTS = [3000, 4000];
const MIN_DISK_FREE_MB = 4 * 1024;
const MIN_NODE_MAJOR = 20;

export async function runDoctor(opts: {
  ports?: number[];
  repoBaseDir?: string;
} = {}): Promise<DoctorReport> {
  const results: CheckResult[] = [];

  results.push(await checkNode());
  results.push(await checkDocker());
  results.push(await checkComposePlugin());
  results.push(await checkDockerDaemon());

  const ports = opts.ports ?? REQUIRED_PORTS;
  for (const p of ports) {
    results.push(await checkPort(p));
  }

  results.push(await checkRepoBaseDir(opts.repoBaseDir));
  results.push(await checkDiskSpace(opts.repoBaseDir));

  results.push(await checkOptional("git", ["--version"], "Used for repo cloning inside the api container; nice-to-have on host"));
  results.push(await checkOptional("gh", ["--version"], "GitHub CLI — recommended for repo auth"));

  return {
    ok: results.every((r) => r.ok),
    results,
  };
}

export function printReport(report: DoctorReport): void {
  for (const r of report.results) {
    if (r.ok) log.ok(`${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
    else {
      log.fail(`${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
      if (r.fix) log.dim(`   ${r.fix}`);
    }
  }
}

async function checkNode(): Promise<CheckResult> {
  const v = process.versions.node;
  const major = parseInt(v.split(".")[0]!, 10);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    return {
      name: "Node.js",
      ok: false,
      detail: `${v} (need >= ${MIN_NODE_MAJOR})`,
      fix: "Install Node 20+ from https://nodejs.org",
    };
  }
  return { name: "Node.js", ok: true, detail: v };
}

async function checkDocker(): Promise<CheckResult> {
  if (!(await which("docker"))) {
    return {
      name: "docker CLI",
      ok: false,
      fix: "Install Docker: https://docs.docker.com/get-docker/",
    };
  }
  const v = await captureVersion("docker", ["--version"]);
  return { name: "docker CLI", ok: true, detail: v ?? undefined };
}

async function checkComposePlugin(): Promise<CheckResult> {
  const res = await run("docker", ["compose", "version"]).catch(
    () => ({ code: 1, stdout: "", stderr: "" })
  );
  if (res.code !== 0) {
    return {
      name: "docker compose plugin",
      ok: false,
      fix: "Install the compose plugin (Docker Desktop bundles it; on Linux: docker-compose-plugin)",
    };
  }
  return {
    name: "docker compose plugin",
    ok: true,
    detail: res.stdout.trim().split("\n")[0],
  };
}

async function checkDockerDaemon(): Promise<CheckResult> {
  const res = await run("docker", ["info", "--format", "{{.ServerVersion}}"]).catch(
    () => ({ code: 1, stdout: "", stderr: "" })
  );
  if (res.code !== 0) {
    return {
      name: "docker daemon",
      ok: false,
      detail: "not reachable",
      fix: process.platform === "darwin"
        ? "Start Docker Desktop"
        : "Start the docker daemon (e.g. `sudo systemctl start docker`) and ensure your user is in the `docker` group",
    };
  }
  return { name: "docker daemon", ok: true, detail: `server ${res.stdout.trim()}` };
}

async function checkPort(port: number): Promise<CheckResult> {
  const free = await isPortFree(port);
  if (free) return { name: `port ${port}`, ok: true, detail: "free" };
  // Soft warning: `init` auto-bumps to the next free port, so a busy default
  // is informational rather than blocking. We still flag it so the operator
  // knows what changed.
  return {
    name: `port ${port}`,
    ok: true,
    detail: "in use — init will pick an alternate (e.g. " + (port + 1) + ")",
  };
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

async function checkRepoBaseDir(p: string | undefined): Promise<CheckResult> {
  const target = expandHome(p ?? path.join(os.homedir(), ".withvibe", "repos"));
  try {
    await fs.mkdir(target, { recursive: true });
    const probe = path.join(target, ".withvibe-write-probe");
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    return { name: "REPO_BASE_DIR writable", ok: true, detail: target };
  } catch (e) {
    return {
      name: "REPO_BASE_DIR writable",
      ok: false,
      detail: `${target} (${(e as Error).message})`,
      fix: `Create the directory and ensure the user running the installer can write to it.`,
    };
  }
}

async function checkDiskSpace(p: string | undefined): Promise<CheckResult> {
  const target = expandHome(p ?? os.homedir());
  const res = await run("df", ["-m", target]).catch(() => null);
  if (!res || res.code !== 0) {
    return { name: "disk space", ok: true, detail: "skipped (df unavailable)" };
  }
  const lines = res.stdout.trim().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return { name: "disk space", ok: true, detail: "skipped" };
  const cols = last.split(/\s+/);
  // BSD/macOS df: Filesystem  1M-blocks  Used  Available  Capacity  Mounted on
  // GNU df:       Filesystem  1M-blocks  Used  Available  Use%      Mounted on
  const availableMb = parseInt(cols[3] ?? "0", 10);
  if (Number.isNaN(availableMb)) {
    return { name: "disk space", ok: true, detail: "skipped" };
  }
  if (availableMb < MIN_DISK_FREE_MB) {
    return {
      name: "disk space",
      ok: false,
      detail: `${availableMb} MB free at ${target}`,
      fix: `Need at least ${MIN_DISK_FREE_MB} MB. Free up space or pick a different REPO_BASE_DIR.`,
    };
  }
  return { name: "disk space", ok: true, detail: `${availableMb} MB free` };
}

async function checkOptional(
  cmd: string,
  versionArgs: string[],
  why: string
): Promise<CheckResult> {
  const ok = await which(cmd);
  if (!ok) {
    return {
      name: `${cmd} (optional)`,
      ok: true,
      detail: `not found — ${why}`,
    };
  }
  const v = await captureVersion(cmd, versionArgs);
  return { name: `${cmd} (optional)`, ok: true, detail: v ?? "found" };
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}
