import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/env-templates/[templateId]">
) {
  const { id, templateId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/env-templates/${templateId}`);
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/env-templates/[templateId]">
) {
  const { id, templateId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/env-templates/${templateId}`);
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/workspaces/[id]/env-templates/[templateId]">
) {
  const { id, templateId } = await ctx.params;
  return proxyToApi(request, `/workspaces/${id}/env-templates/${templateId}`);
}
