/**
 * Checking an Anthropic key before storing it.
 *
 * Keys used to be stored verbatim and discovered to be wrong at the next turn,
 * as `AI request failed (…)` in a chat — which names neither the key nor where
 * it came from. Two failures look identical there and have nothing to do with
 * each other: a value that is not an Anthropic key at all, and a real key the
 * API refuses. Both are worth saying plainly at the moment someone pastes one.
 *
 * The live check matters more than the shape check. An OAuth token whose
 * organization has since disabled OAuth has a perfectly valid shape and fails
 * every request with "OAuth authentication is currently not allowed for this
 * organization" — an answer only Anthropic can give.
 */

/** Cheapest real request that proves a key works: one token from Haiku. */
const PROBE_MODEL = "claude-haiku-4-5-20251001";
const PROBE_TIMEOUT_MS = 20_000;

export class AnthropicKeyError extends Error {}

export type KeyKind = "api" | "oauth";

/**
 * Shape only. `sk-ant-oat*` is a Claude subscription OAuth token and goes out
 * as a bearer; anything else beginning `sk-ant-` is a Console API key and goes
 * out as x-api-key. Both are legitimate — what is not is a value from some
 * other service entirely, which is the mistake that actually happens.
 */
export function classifyAnthropicKey(key: string): KeyKind {
  const trimmed = key.trim();
  if (!trimmed.startsWith("sk-ant-")) {
    throw new AnthropicKeyError(
      "That doesn't look like an Anthropic key. Console keys start with " +
        "sk-ant-api…, Claude subscription tokens with sk-ant-oat…. Create one " +
        "at console.anthropic.com/settings/keys."
    );
  }
  return trimmed.startsWith("sk-ant-oat") ? "oauth" : "api";
}

/**
 * Ask Anthropic whether the key works, and throw with their own wording when
 * it does not. Returns the kind of key it turned out to be.
 */
export async function verifyAnthropicKey(key: string): Promise<KeyKind> {
  const trimmed = key.trim();
  const kind = classifyAnthropicKey(trimmed);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (kind === "oauth") {
    headers.authorization = `Bearer ${trimmed}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  } else {
    headers["x-api-key"] = trimmed;
  }

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    // Reaching Anthropic is not the user's problem to debug, and refusing to
    // store a key because our network blinked would be worse than storing it.
    throw new AnthropicKeyError(
      `Could not reach Anthropic to check the key: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (res.ok) return kind;

  const detail = await res
    .json()
    .then((b: unknown) => {
      const e = (b as { error?: { message?: unknown } })?.error;
      return typeof e?.message === "string" ? e.message : null;
    })
    .catch(() => null);

  if (res.status === 401) {
    throw new AnthropicKeyError(
      detail
        ? `Anthropic rejected that key: ${detail}`
        : "Anthropic rejected that key. Check it was copied in full and has not been revoked."
    );
  }
  if (res.status === 403) {
    // The org-policy case. The key is real; the account may not use it this way.
    throw new AnthropicKeyError(
      detail ? `Anthropic refused that key: ${detail}` : "Anthropic refused that key."
    );
  }
  if (res.status === 429) {
    throw new AnthropicKeyError(
      "That key is rate limited right now, so it could not be checked. Try again shortly."
    );
  }
  throw new AnthropicKeyError(
    detail
      ? `Anthropic returned ${res.status} when checking the key: ${detail}`
      : `Anthropic returned ${res.status} when checking the key.`
  );
}
