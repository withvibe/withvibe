import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/members/me">
) {
  const { id } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/members/me`);
}
