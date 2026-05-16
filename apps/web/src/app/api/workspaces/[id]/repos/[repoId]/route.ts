import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/repos/[repoId]">
) {
  const { id, repoId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/repos/${repoId}`);
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/repos/[repoId]">
) {
  const { id, repoId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/repos/${repoId}`);
}
