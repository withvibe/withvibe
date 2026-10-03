import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/compute/aws">
) {
  const { id } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/compute/aws`);
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/compute/aws">
) {
  const { id } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/compute/aws`);
}
