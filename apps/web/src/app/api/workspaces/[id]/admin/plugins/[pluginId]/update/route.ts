import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/admin/plugins/[pluginId]/update">
) {
  const { id, pluginId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/admin/plugins/${pluginId}/update`
  );
}
