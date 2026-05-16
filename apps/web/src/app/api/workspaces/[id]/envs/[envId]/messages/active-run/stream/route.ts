import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

// SSE stream — proxyToApi passes the ReadableStream body through unchanged.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/messages/active-run/stream">
) {
  const { id, envId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId");
  const suffix = sessionId
    ? `?sessionId=${encodeURIComponent(sessionId)}`
    : "";
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/messages/active-run/stream${suffix}`
  );
}
