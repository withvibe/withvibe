import { promises as fs } from "node:fs";
import * as path from "node:path";

// Cached after the first successful resolve so we don't hit disk on every
// bootstrap call.
let cached: string | null = null;

/**
 * Resolve the running app version for display.
 *
 * Precedence:
 *   1. WITHVIBE_VERSION env var, when it's a real version (not "latest"/"dev").
 *      The CLI sets this from its own package.json during `withvibe init`.
 *   2. apps/api/package.json on disk (baked into the container at build time).
 *   3. The literal string "dev" as a last-resort label.
 *
 * Resolved once per process; subsequent calls return the cached value.
 */
export async function getAppVersion(): Promise<string> {
  if (cached) return cached;

  const envVersion = process.env.WITHVIBE_VERSION?.trim();
  if (envVersion && envVersion !== "latest" && envVersion !== "dev") {
    return (cached = envVersion);
  }

  try {
    // __dirname is apps/api/dist/common at runtime → ../../package.json
    // resolves to apps/api/package.json (copied into /app by the Dockerfile).
    const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
    const raw = await fs.readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (parsed.version) return (cached = parsed.version);
  } catch {
    // Fall through to "dev".
  }

  return (cached = "dev");
}
