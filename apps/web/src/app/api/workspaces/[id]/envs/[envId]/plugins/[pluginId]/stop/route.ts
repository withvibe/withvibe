import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/plugins/[pluginId]/stop">
) {
  const { id, envId, pluginId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/plugins/${pluginId}/stop`
  );
}
