import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

// Streams a chat-message attachment through the Next dev proxy. Headers
// (Content-Type, Content-Length, Content-Disposition) come from NestJS so
// images render inline and other types prompt a download.
export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/envs/[envId]/attachments/[attId]">
) {
  const { id, envId, attId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/attachments/${encodeURIComponent(attId)}`
  );
}
