import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Per-user config: `~/.withvibe/config.json`. Contains the device token and
// the server URL it was minted against. Mode 0600 — readable only by owner.
export type CliConfig = {
  server: string;
  token: string;
  savedAt: string;
};

function configDir(): string {
  return path.join(os.homedir(), ".withvibe");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

export async function loadConfig(): Promise<CliConfig | null> {
  try {
    const raw = await fs.readFile(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    if (!parsed.server || !parsed.token) return null;
    return {
      server: parsed.server,
      token: parsed.token,
      savedAt: parsed.savedAt || "",
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function saveConfig(cfg: CliConfig): Promise<void> {
  await fs.mkdir(configDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(configPath(), JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  });
}

export async function clearConfig(): Promise<void> {
  try {
    await fs.unlink(configPath());
  } catch (err: unknown) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
}

// Root the CLI uses for everything it creates on the user's machine.
export function withvibeHome(): string {
  return path.join(os.homedir(), "withvibe");
}
