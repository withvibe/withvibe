import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/envs/${envId}`);
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/envs/${envId}`);
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/envs/${envId}`);
}
