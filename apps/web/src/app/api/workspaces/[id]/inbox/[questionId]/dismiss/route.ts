import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/inbox/[questionId]/dismiss">
) {
  const { id, questionId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/inbox/${questionId}/dismiss`);
}
