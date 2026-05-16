import { chmod, chown, mkdir } from "fs/promises";
import os from "os";
import path from "path";

/**
 * Resolve the base directory for cloned repos. Defaults to `~/.withvibe/repos`
 * (the standard withvibe data location, matching the CLI installer and doctor
 * probe). `REPO_BASE_DIR` can override; setting it under `/tmp` is rejected —
 * the prior silent `/tmp/shared-ai-repos` fallback was wiped on container
 * rebuild (overlayfs) or host reboot, making clones look like they
 * "disappear between sessions".
 */
export function resolveRepoBaseDir(): string {
  const raw = process.env.REPO_BASE_DIR;
  if (!raw || !raw.trim()) {
    return path.join(os.homedir(), ".withvibe", "repos");
  }
  const resolved = path.resolve(raw);
  if (resolved === "/tmp" || resolved.startsWith("/tmp/")) {
    throw new Error(
      `REPO_BASE_DIR="${raw}" points under /tmp, which is ephemeral ` +
        "(wiped on container rebuild / host reboot). Use a persistent path."
    );
  }
  return resolved;
}

// gid of the `claude` user the api Dockerfile creates. Claude Code runs as
// this uid via the wrapper (see apps/api/Dockerfile) — anything claude needs
// to write must be group-owned by this gid with group-write set. Exported
// so sidecars that bind-mount the env dir (e.g. code-server) can join this
// group and write the same group-writable files.
export const CLAUDE_GID = 1500;

// Mode 02775 = rwxrwsr-x: group-writable + setgid bit. The setgid bit makes
// every dir created underneath inherit gid=1500, so deeply-nested paths the
// runner agent touches stay claude-writable without needing chown at every
// level.
const ENV_DIR_MODE = 0o2775;

/**
 * Idempotently create an env directory with permissions that let the runner's
 * `claude` user write into it. The api process runs as root inside its
 * container (it needs docker.sock), so a naive `mkdir` produces dirs owned
 * `root:root` mode `0o755` — and the agent (running as gid 1500 inside the
 * runner container) gets EACCES the moment it tries to write a compose file
 * or edit a repo file.
 *
 * Call this from anywhere that previously did
 *   await mkdir(envDir, { recursive: true })
 * The chown/chmod silently no-op when not running as root (e.g. local dev),
 * so this is safe in every environment.
 */
export async function ensureEnvDir(envDir: string): Promise<void> {
  await mkdir(envDir, { recursive: true });
  // Only root can chown to an arbitrary gid. EPERM means "not running as
  // root" (local dev / tests) — perms don't matter there since claude runs
  // as the host user too. Other errors should propagate.
  try {
    await chown(envDir, 0, CLAUDE_GID);
    await chmod(envDir, ENV_DIR_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
  }
}
