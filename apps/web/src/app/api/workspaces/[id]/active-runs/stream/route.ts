import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

// SSE stream — proxyToApi passes the ReadableStream body through unchanged.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/active-runs/stream">
) {
  const { id } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/active-runs/stream`);
}
