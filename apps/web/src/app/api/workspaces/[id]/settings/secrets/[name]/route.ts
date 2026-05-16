import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function PUT(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/settings/secrets/[name]">
) {
  const { id, name } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/settings/secrets/${encodeURIComponent(name)}`
  );
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/settings/secrets/[name]">
) {
  const { id, name } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/settings/secrets/${encodeURIComponent(name)}`
  );
}
