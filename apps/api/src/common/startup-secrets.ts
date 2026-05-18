/**
 * Boot-time secret guard (security finding C4).
 *
 * `INTERNAL_JWT_SECRET` signs every user session cookie AND every web→api
 * bridge / MCP-bridge / WS token. If it ships as the documented placeholder
 * or empty (which happens on the manual `docker compose up` path that
 * bypasses the CLI installer), anyone who read the public source can forge
 * an admin session — and, because the MCP-bridge token is scoped purely by
 * env id, anyone who knows an env id can drive that env's privileged tools.
 *
 * So: in production we refuse to start on a weak/empty/placeholder secret.
 * Outside production we only warn (local dev with the example secret must
 * still run), but loudly — this must never reach a deployment.
 *
 * The Postgres password is checked too, but only as a warning: the postgres
 * service publishes no host port (compose network only), so its blast radius
 * is far smaller than the JWT secret's.
 */

/** Exact values shipped in this repo's example/template files. */
const KNOWN_PLACEHOLDERS = [
  "replace-me-with-32-bytes-of-randomness",
  "dev-bridge-secret-change-in-production-64chars",
  "changeme",
  "change-in-production",
];

/**
 * Separator-insensitive markers. We compare against the secret with every
 * non-alphanumeric char stripped, so `__REPLACE_ME__`, `change-me`,
 * `change_me`, `dev-bridge-secret`, … are all caught regardless of styling.
 * Kept tight (no generic word like "example") so a real random base64/hex
 * secret cannot trip it.
 */
const PLACEHOLDER_MARKERS = [
  "replaceme",
  "changeme",
  "changeinproduction",
  "yoursecret",
  "devbridgesecret",
  "placeholder",
  "tobereplaced",
];

const MIN_SECRET_LEN = 32;

function classifySecret(
  value: string | undefined
): { weak: true; reason: string } | { weak: false } {
  if (!value || !value.trim()) return { weak: true, reason: "is empty or unset" };
  const s = value.trim();
  if (s.length < MIN_SECRET_LEN)
    return {
      weak: true,
      reason: `is too short (${s.length} chars; need ≥ ${MIN_SECRET_LEN})`,
    };
  const lower = s.toLowerCase();
  if (KNOWN_PLACEHOLDERS.includes(lower))
    return { weak: true, reason: "is a known example/placeholder value" };
  const compact = lower.replace(/[^a-z0-9]/g, "");
  if (PLACEHOLDER_MARKERS.some((m) => compact.includes(m)))
    return { weak: true, reason: "looks like a placeholder, not a real secret" };
  return { weak: false };
}

/** Weak/default Postgres passwords this project has shipped or commonly sees. */
const WEAK_DB_PASSWORDS = ["withvibe", "postgres", "changeme", "password"];

export type SecretAudit = { fatal: string[]; warnings: string[] };

/**
 * Pure policy evaluation — no logging, no process exit. Returns the fatal
 * problems (block boot in production) and non-fatal warnings. Exposed
 * separately so it can be exercised without spawning the server.
 */
export function evaluateSecretConfig(env: NodeJS.ProcessEnv): SecretAudit {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const jwt = classifySecret(env.INTERNAL_JWT_SECRET);
  if (jwt.weak) {
    fatal.push(
      `INTERNAL_JWT_SECRET ${jwt.reason}. It signs every session and bridge ` +
        `token — a guessable value lets anyone forge admin sessions and, via ` +
        `the env-scoped MCP bridge, control any env by id. Generate one with: ` +
        `openssl rand -hex 32`
    );
  }

  const dbUrl = env.DATABASE_URL || "";
  const m = /^[^:]+:\/\/[^:@/]+:([^@/]*)@/.exec(dbUrl);
  const dbPass = m ? decodeURIComponent(m[1]) : "";
  if (dbPass && WEAK_DB_PASSWORDS.includes(dbPass.toLowerCase())) {
    warnings.push(
      `DATABASE_URL uses a weak/default Postgres password ("${dbPass}"). ` +
        `Set a strong POSTGRES_PASSWORD (openssl rand -hex 24).`
    );
  }

  return { fatal, warnings };
}

/** Minimal logger surface so this works before the Nest app exists. */
type BootLogger = {
  warn: (m: string) => void;
  fatal?: (m: string) => void;
  error: (m: string) => void;
};

/**
 * Enforce the policy at boot. Call as the very first thing in `bootstrap()`.
 * In production, a fatal problem exits the process (fail closed). Outside
 * production it is logged loudly but allowed.
 */
export function assertSecretsAtBoot(
  env: NodeJS.ProcessEnv = process.env,
  logger: BootLogger = console
): void {
  const isProd = env.NODE_ENV === "production";
  const { fatal, warnings } = evaluateSecretConfig(env);

  for (const w of warnings) logger.warn(`[security] ${w}`);

  if (fatal.length === 0) return;
  const banner = fatal.map((f) => `  • ${f}`).join("\n");

  if (isProd) {
    (logger.fatal ?? logger.error).call(
      logger,
      `[security] Refusing to start — insecure secret configuration in ` +
        `production:\n${banner}`
    );
    process.exit(1);
  }

  logger.warn(
    `[security] Insecure secret configuration detected. Allowed only ` +
      `because NODE_ENV != "production" — this MUST NOT reach a deployment:\n` +
      banner
  );
}
