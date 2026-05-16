import { NextRequest } from "next/server";
import { proxyToApiPublic } from "@/lib/proxy-to-api";

// Public — no session required. Anyone with the token link can preview.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/invitations/[token]">
) {
  const { token } = await ctx.params;
  return proxyToApiPublic(request, `/invitations/${token}`);
}
