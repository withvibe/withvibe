import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; envId: string }> }
) {
  const { id, envId } = await ctx.params;
  return proxyToApi(
    request,
    `/workspaces/${id}/envs/${envId}/qa-browser/extension`
  );
}
