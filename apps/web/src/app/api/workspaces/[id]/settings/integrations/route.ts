import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/settings/integrations">
) {
  const { id } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/settings/integrations`);
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/settings/integrations">
) {
  const { id } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/settings/integrations`);
}
