import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/security-scan">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/envs/${envId}/security-scan`);
}

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/security-scan">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/envs/${envId}/security-scan`);
}
