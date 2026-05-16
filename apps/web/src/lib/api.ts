import { cookies, headers } from "next/headers";

const API_BASE = process.env.API_BASE_URL || "http://localhost:4000";

/**
 * Server-side fetch helper. Forwards the user's session cookie to NestJS so
 * the request authenticates as the same user. Use from server components,
 * route handlers, and other server contexts. Never use from client code —
 * the browser already sends the cookie automatically there.
 */
export async function apiFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  const url = `${API_BASE}/api${path.startsWith("/") ? "" : "/"}${path}`;
  const reqHeaders = new Headers(init.headers);
  if (cookieHeader) reqHeaders.set("cookie", cookieHeader);

  // Forward x-forwarded-for so NestJS logs see the real client IP.
  const incoming = await headers();
  const xff = incoming.get("x-forwarded-for");
  if (xff) reqHeaders.set("x-forwarded-for", xff);

  return fetchWithBootRetry(url, { ...init, headers: reqHeaders });
}

/**
 * Server-side JSON fetch with parsed body. Returns `null` on 401/404 so
 * callers can branch on "not found / not authed" without try/catch.
 * Throws on other non-OK status codes.
 */
export async function apiJson<T>(
  path: string,
  init: RequestInit = {}
): Promise<T | null> {
  const res = await apiFetch(path, init);
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`apiJson ${path} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Retry against ECONNREFUSED — absorbs the Nest cold-start window during
 * `pnpm dev`, where the web app may accept a request before the API process
 * is listening. Up to ~3s of waiting, then give up.
 */
async function fetchWithBootRetry(
  url: string,
  init: RequestInit
): Promise<Response> {
  const backoffsMs = [150, 300, 500, 800, 1200];
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      const cause = (err as { cause?: { code?: string } })?.cause;
      if (cause?.code !== "ECONNREFUSED" || i >= backoffsMs.length) throw err;
      await new Promise((r) => setTimeout(r, backoffsMs[i]));
    }
  }
}
