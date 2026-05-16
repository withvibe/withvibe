import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/invitations/[token]/accept">
) {
  const { token } = await ctx.params;
  return proxyToApi(request, `/invitations/${token}/accept`);
}
