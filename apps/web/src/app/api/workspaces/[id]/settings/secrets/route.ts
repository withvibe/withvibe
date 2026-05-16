import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/settings/secrets">
) {
  const { id } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/settings/secrets`);
}

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/settings/secrets">
) {
  const { id } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/settings/secrets`);
}
