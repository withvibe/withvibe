import { execFile } from "child_process";
import { promisify } from "util";
import { access } from "node:fs/promises";

const exec = promisify(execFile);

/**
 * Shared networking helpers for the on-demand sidecars (code-server, Adminer)
 * so a *containerized* api can reach them the same way it reaches the QA
 * browser: by container IP on the shared `withvibe` network.
 *
 * These sidecars are launched with `--network <env compose net>` and a
 * loopback-only published port (127.0.0.1:0:<internal>). That's reachable
 * from a dev api running on the host, but NOT from the api running inside a
 * container — its 127.0.0.1 is its own loopback. Joining them to `withvibe`
 * (same trick BrowserSidecarService uses) gives the api an IP it can dial.
 */

let inContainerCache: boolean | undefined;

/** True when the api itself runs inside a container (deployed), not on the host (dev). */
export async function apiInContainer(): Promise<boolean> {
  if (inContainerCache !== undefined) return inContainerCache;
  try {
    await access("/.dockerenv");
    inContainerCache = true;
  } catch {
    inContainerCache = false;
  }
  return inContainerCache;
}

async function containerIpOnWithvibe(
  containerId: string
): Promise<string | null> {
  try {
    const { stdout } = await exec("docker", [
      "inspect",
      "-f",
      "{{.NetworkSettings.Networks.withvibe.IPAddress}}",
      containerId,
    ]);
    const ip = stdout.trim();
    return ip && ip !== "<no value>" ? ip : null;
  } catch {
    return null;
  }
}

/** Best-effort: join a running sidecar to the `withvibe` network. Idempotent. */
export async function attachToWithvibe(containerId: string): Promise<void> {
  await exec("docker", ["network", "connect", "withvibe", containerId]).catch(
    () => {
      // Already attached, or the network/container is gone — both fine; the
      // IP lookup that follows is the real source of truth.
    }
  );
}

async function containerAlive(containerId: string): Promise<boolean> {
  try {
    const { stdout } = await exec(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", containerId],
      { timeout: 5_000 }
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Resolve a `host:port` the api can reach a running sidecar at, or null if
 * it isn't running. In-container: container IP on `withvibe` + the internal
 * port — self-heals by attaching to `withvibe` if a pre-existing container
 * wasn't joined at start. On the host (dev): 127.0.0.1 + the published port.
 */
export async function resolveSidecarTarget(args: {
  containerId: string | null | undefined;
  status: string | null | undefined;
  publishedPort: number | null | undefined;
  internalPort: number;
}): Promise<string | null> {
  const { containerId, status, publishedPort, internalPort } = args;
  if (!containerId || status !== "running") return null;
  if (!(await containerAlive(containerId))) return null;

  if (await apiInContainer()) {
    let ip = await containerIpOnWithvibe(containerId);
    if (!ip) {
      // Pre-existing container started before withvibe-attach shipped, or a
      // racy start — try once to join, then re-read.
      await attachToWithvibe(containerId);
      ip = await containerIpOnWithvibe(containerId);
    }
    if (ip) return `${ip}:${internalPort}`;
    // Fall through to loopback as a last resort (works if api is on host
    // despite /.dockerenv — unlikely, but harmless).
  }
  return publishedPort ? `127.0.0.1:${publishedPort}` : null;
}
