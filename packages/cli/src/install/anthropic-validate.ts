// Validate an Anthropic credential. Two formats are accepted:
//   sk-ant-api*  — API key. Live-checked against /v1/messages/count_tokens
//                  (doesn't bill).
//   sk-ant-oat*  — Claude Max/Pro OAuth token. /v1/messages doesn't accept
//                  these (they auth differently), so we accept them on
//                  shape alone and let the api route to CLAUDE_CODE_OAUTH_TOKEN.
//
// The api code at chat-stream.service.ts:111 detects the prefix and sets
// the right env var when spawning the claude CLI, so both flavors can live
// in the ANTHROPIC_API_KEY slot of .env.

const ENDPOINT = "https://api.anthropic.com/v1/messages/count_tokens";
const MODEL = "claude-haiku-4-5-20251001";

export type ValidateResult =
  | { ok: true; kind: "api-key" | "oauth-token" }
  | { ok: false; status?: number; error: string };

export function classifyKey(key: string): "api-key" | "oauth-token" | "unknown" {
  const t = key.trim();
  if (t.startsWith("sk-ant-api")) return "api-key";
  if (t.startsWith("sk-ant-oat")) return "oauth-token";
  return "unknown";
}

export async function validateAnthropicKey(
  key: string,
  timeoutMs = 8000
): Promise<ValidateResult> {
  const kind = classifyKey(key);
  if (kind === "unknown") {
    return {
      ok: false,
      error: "Key must start with `sk-ant-api` (API key) or `sk-ant-oat` (Claude Max/Pro OAuth token).",
    };
  }
  // OAuth tokens can't be checked via /v1/messages/count_tokens — that
  // endpoint is x-api-key only. Trust the shape; the claude CLI will
  // surface a clear error on first run if the token is bad.
  if (kind === "oauth-token") return { ok: true, kind };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    if (res.ok) return { ok: true, kind };
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      // ignore
    }
    return { ok: false, status: res.status, error: detail };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message || "network error",
    };
  } finally {
    clearTimeout(timer);
  }
}
