import { MAX_BIO_LENGTH, MAX_FREE_TEXT_LENGTH, MAX_POSITIONS } from "@withvibe/db";

function asTrimmedString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function asPositionsArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim().slice(0, MAX_FREE_TEXT_LENGTH);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_POSITIONS) break;
  }
  return out;
}

/**
 * Parse user-profile input: positions (multi-select — accepts any non-empty
 * strings, both known slugs and custom free text), and bio.
 *
 * Each field is only returned if present in body so callers can do partial updates.
 */
export function parseUserProfileInput(body: {
  positions?: unknown;
  bio?: unknown;
}): {
  positions?: string[];
  bio?: string | null;
} {
  const out: { positions?: string[]; bio?: string | null } = {};

  if (body.positions !== undefined) {
    out.positions = asPositionsArray(body.positions);
  }

  if (body.bio !== undefined) {
    out.bio = asTrimmedString(body.bio, MAX_BIO_LENGTH);
  }

  return out;
}
