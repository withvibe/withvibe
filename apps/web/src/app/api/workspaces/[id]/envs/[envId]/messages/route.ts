import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/messages">
) {
  const { id, envId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  const suffix = sessionId
    ? `?sessionId=${encodeURIComponent(sessionId)}`
    : "";
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/messages${suffix}`
  );
}

// Streaming SSE — proxyToApi pipes the ReadableStream body through unchanged.
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/messages">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/envs/${envId}/messages`);
}
