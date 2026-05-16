import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/envs/[envId]/local-bundle">
) {
  const { envId } = await ctx.params;
  return proxyToApi(request, `/envs/${envId}/local-bundle`);
}
