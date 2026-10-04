import { createHmac, timingSafeEqual } from "crypto";

/**
 * Credential a sandbox presents to the git proxy.
 *
 * The point of the proxy is that no GitHub credential ever enters the client's
 * cloud, so the sandbox needs *some* credential of its own — one that is worth
 * nothing outside this platform. This is it: an HMAC over (env, user) that
 * grants exactly "act on this env's repos as this user" and nothing else.
 *
 * It carries the user id in the clear on purpose. Authentication against GitHub
 * is still a single workspace token today, but every request through the proxy
 * knows which person is behind it — so the audit trail is real now, and the day
 * per-user GitHub auth exists, picking a different credential is a change to
 * one function rather than a change to the protocol.
 *
 * Derivation mirrors the exec bridge's token: deterministic from
 * INTERNAL_JWT_SECRET, no expiry, nothing new to persist or rotate. A token is
 * scoped to one env, and an env's repos are exactly what that sandbox can
 * already read — so a leaked token grants the holder what the sandbox holding
 * it already had.
 */

const VERSION = "wvg1";
const SIGNATURE_CHARS = 32;

/** Ids must not contain the delimiter. cuids never do; a guard beats a
 * forgeable token if that ever changes. */
const ID_RE = /^[A-Za-z0-9_-]+$/;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`git-proxy:${payload}`)
    .digest("hex")
    .slice(0, SIGNATURE_CHARS);
}

export function mintGitProxyToken(
  envId: string,
  userId: string,
  secret: string = process.env.INTERNAL_JWT_SECRET || ""
): string {
  if (!secret) throw new Error("INTERNAL_JWT_SECRET is required to mint a git proxy token");
  if (!ID_RE.test(envId)) throw new Error(`unsafe envId for git proxy token: ${envId}`);
  if (!ID_RE.test(userId)) throw new Error(`unsafe userId for git proxy token: ${userId}`);
  const payload = `${envId}.${userId}`;
  return `${VERSION}.${payload}.${sign(payload, secret)}`;
}

export function verifyGitProxyToken(
  token: string,
  secret: string = process.env.INTERNAL_JWT_SECRET || ""
): { envId: string; userId: string } | null {
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, envId, userId, signature] = parts;
  if (version !== VERSION) return null;
  if (!ID_RE.test(envId) || !ID_RE.test(userId)) return null;

  const expected = sign(`${envId}.${userId}`, secret);
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return { envId, userId };
}

/** Pull the token out of an `Authorization` header. Git sends Basic for a
 * username/password remote and Bearer when the header is set directly; accept
 * both so the sandbox can use whichever is less awkward in context. */
export function tokenFromAuthHeader(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ", 2);
  if (!value) return null;
  if (scheme.toLowerCase() === "bearer") return value.trim();
  if (scheme.toLowerCase() === "basic") {
    const decoded = Buffer.from(value.trim(), "base64").toString("utf-8");
    const sep = decoded.indexOf(":");
    if (sep === -1) return decoded || null;
    // Git fills the username with whatever the URL carried; the token may be
    // in either field, so take whichever one looks like ours.
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    if (pass.startsWith(`${VERSION}.`)) return pass;
    if (user.startsWith(`${VERSION}.`)) return user;
    return pass || null;
  }
  return null;
}
