import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/context/file/text">
) {
  const { id, envId } = await ctx.params;
  const search = request.nextUrl.search;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/context/file/text${search}`
  );
}
