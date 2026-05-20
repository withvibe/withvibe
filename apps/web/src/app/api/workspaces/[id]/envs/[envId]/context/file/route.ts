import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/context/file">
) {
  const { id, envId } = await ctx.params;
  const search = request.nextUrl.search;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/context/file${search}`
  );
}

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/context/file">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/context/file`
  );
}

export async function PUT(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/context/file">
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/context/file`
  );
}
