import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/admin/plugins/[pluginId]">
) {
  const { id, pluginId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/admin/plugins/${pluginId}`);
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/admin/plugins/[pluginId]">
) {
  const { id, pluginId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/admin/plugins/${pluginId}`);
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/admin/plugins/[pluginId]">
) {
  const { id, pluginId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/admin/plugins/${pluginId}`);
}
