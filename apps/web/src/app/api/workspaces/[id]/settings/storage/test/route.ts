import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/settings/storage/test">
) {
  const { id } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/settings/storage/test`);
}
