import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/admin/plugins/install-from-marketplace">
) {
  const { id } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/admin/plugins/install-from-marketplace`
  );
}
