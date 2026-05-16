import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/assets/[...assetPath]">
) {
  const { id, envId, assetPath } = await ctx.params;
  const joined = Array.isArray(assetPath)
    ? assetPath.map(encodeURIComponent).join("/")
    : encodeURIComponent(assetPath ?? "");
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/assets/${joined}`
  );
}
