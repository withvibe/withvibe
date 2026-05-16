import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir, statePath } from "./paths.js";

export type InstallMode = "from-source" | "from-bundle" | "from-registry";

export type InstallState = {
  version: 1;
  mode: InstallMode;
  installDir: string;
  installedAt: string;
  features: {
    traefik: boolean;
    qaBrowser: boolean;
    codeServer: boolean;
    googleOAuth: boolean;
  };
  registry?: {
    namespace: string; // e.g. "ghcr.io/withvibe"
    tag: string; // e.g. "latest" or "0.1.0"
  };
  source?: {
    repoPath: string; // absolute path to the cloned source tree
  };
  bundle?: {
    bundlePath: string; // absolute path to the bundle dir or .tar.gz used
    version?: string; // image tag the bundle ships (read from bundle.json)
  };
  traefik?: {
    baseDomain: string;
    // TLS method. Absent ⇒ "acme" (back-compat with installs written before
    // bring-your-own-cert support).
    tls?: "acme" | "byocert";
    // Present for ACME (Let's Encrypt) installs.
    acmeEmail?: string;
    // Present for bring-your-own-cert installs — the original host paths the
    // operator supplied (the files are copied into <installDir>/certs/).
    certPath?: string;
    keyPath?: string;
  };
};

export async function readState(installDir: string): Promise<InstallState | null> {
  try {
    const text = await fs.readFile(statePath(installDir), "utf8");
    const parsed = JSON.parse(text) as InstallState;
    if (parsed?.version === 1) return parsed;
    return null;
  } catch {
    return null;
  }
}

export async function writeState(
  installDir: string,
  state: InstallState
): Promise<void> {
  await ensureDir(installDir);
  const tmp = statePath(installDir) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  await fs.rename(tmp, statePath(installDir));
}

export function defaultFeatures(): InstallState["features"] {
  return {
    traefik: false,
    qaBrowser: true,
    codeServer: true,
    googleOAuth: false,
  };
}
