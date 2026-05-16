import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

export const DEFAULT_INSTALL_DIR = path.join(os.homedir(), ".withvibe");
export const DEFAULT_REPO_BASE_DIR = path.join(DEFAULT_INSTALL_DIR, "repos");
export const STATE_FILENAME = "install.json";
export const ENV_FILENAME = ".env";
export const COMPOSE_FILENAME = "docker-compose.yml";

export function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export function statePath(installDir: string): string {
  return path.join(installDir, STATE_FILENAME);
}

export function envPath(installDir: string): string {
  return path.join(installDir, ENV_FILENAME);
}

export function composePath(installDir: string): string {
  return path.join(installDir, COMPOSE_FILENAME);
}
