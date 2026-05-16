import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/sessions/[sessionId]">
) {
  const { id, envId, sessionId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/sessions/${sessionId}`
  );
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/sessions/[sessionId]">
) {
  const { id, envId, sessionId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/sessions/${sessionId}`
  );
}
