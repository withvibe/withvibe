import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function PUT(
  request: NextRequest,
  ctx: RouteContext<
    "/api/workspaces/[id]/envs/[envId]/agents/[agentId]/disabled"
  >
) {
  const { id, envId, agentId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/agents/${agentId}/disabled`
  );
}
