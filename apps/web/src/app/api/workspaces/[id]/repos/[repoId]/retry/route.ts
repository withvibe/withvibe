import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/repos/[repoId]/retry">
) {
  const { id, repoId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/repos/${repoId}/retry`);
}
