import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

// SSE stream — proxyToApi passes the response body through unchanged so the
// event stream from NestJS reaches the browser as-is.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/container/logs">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/envs/${envId}/container/logs`);
}
