import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/repos/[repoId]/branches">
) {
  const { id, repoId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/repos/${repoId}/branches`);
}
