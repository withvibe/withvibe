import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/admin/plugins/marketplace/catalog">
) {
  const { id } = await ctx.params;
  const url = new URL(request.url);
  const search = url.searchParams.toString();
  return proxyToApi(
    request,
    `/workspaces/${id}/admin/plugins/marketplace/catalog${search ? `?${search}` : ""}`
  );
}
