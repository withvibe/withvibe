import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/admin/plugins/[pluginId]/update">
) {
  const { pluginId } = await ctx.params;
  return proxyToApi(request, `/admin/plugins/${pluginId}/update`);
}
