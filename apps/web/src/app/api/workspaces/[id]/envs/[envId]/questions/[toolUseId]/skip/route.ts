import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/questions/[toolUseId]/skip">
) {
  const { id, envId, toolUseId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/questions/${toolUseId}/skip`
  );
}
