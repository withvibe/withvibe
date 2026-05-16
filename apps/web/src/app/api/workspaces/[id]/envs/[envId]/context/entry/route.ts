import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/context/entry">
) {
  const { id, envId } = await ctx.params;
  const search = request.nextUrl.search;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/context/entry${search}`
  );
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/context/entry">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/context/entry`
  );
}
