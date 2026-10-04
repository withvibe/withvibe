/**
 * Default base domain for subdomain-routed envs when the caller didn't pick
 * one. Self-hosters point `WITHVIBE_ROUTING_BASE_DOMAIN` at their own wildcard
 * domain (the CLI sets it at install time); unset falls back to "localhost" —
 * NOT a vendor domain — so local / from-source installs don't route env URLs
 * at withvibe.dev.
 *
 * Read at call time rather than module load so tests and the config module can
 * change it without import-order surprises.
 */
export function defaultRoutingBaseDomain(): string {
  return process.env.WITHVIBE_ROUTING_BASE_DOMAIN?.trim() || "localhost";
}
