import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/agents/[agentId]">
) {
  const { id, agentId } = await ctx.params;
  const envId = request.nextUrl.searchParams.get("envId");
  const suffix = envId ? `?envId=${encodeURIComponent(envId)}` : "";
  return proxyToApi(request, `/workspaces/${id}/agents/${agentId}${suffix}`);
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/agents/[agentId]">
) {
  const { id, agentId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/agents/${agentId}`);
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/agents/[agentId]">
) {
  const { id, agentId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/agents/${agentId}`);
}
