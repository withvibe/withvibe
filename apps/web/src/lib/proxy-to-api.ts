const API_BASE = process.env.API_BASE_URL || "http://localhost:4000";

/**
 * Retry against ECONNREFUSED — absorbs the Nest cold-start window during
 * `pnpm dev`. Up to ~3s of waiting, then give up.
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

/**
 * Forward a Next.js Request to the NestJS API. The browser's session cookie
 * (or any `Authorization: Bearer` header from the CLI) is forwarded
 * verbatim — NestJS authenticates against the same secret either way.
 *
 * Usage inside a Next.js route handler:
 *   export async function GET(req: NextRequest, ctx: RouteContext<...>) {
 *     const { id } = await ctx.params;
 *     return proxyToApi(req, `/workspaces/${id}/envs`);
 *   }
 */
export async function proxyToApi(
  req: Request,
  apiPath: string
): Promise<Response> {
  const url = `${API_BASE}/api${apiPath.startsWith("/") ? "" : "/"}${apiPath}`;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  const auth = req.headers.get("authorization");
  if (auth) headers.set("authorization", auth);

  headers.set("x-forwarded-for", req.headers.get("x-forwarded-for") || "");

  const method = req.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const apiRes = await fetchWithBootRetry(url, {
    method,
    headers,
    body: hasBody ? await req.clone().arrayBuffer() : undefined,
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);

  // Mirror the response back. Streaming bodies pass through unchanged.
  return new Response(apiRes.body, {
    status: apiRes.status,
    statusText: apiRes.statusText,
    headers: new Headers(apiRes.headers),
  });
}

/** Variant for routes that don't require a user session. */
export async function proxyToApiPublic(
  req: Request,
  apiPath: string
): Promise<Response> {
  return proxyToApi(req, apiPath);
}
