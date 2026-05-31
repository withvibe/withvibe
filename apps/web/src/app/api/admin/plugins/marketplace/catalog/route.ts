import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const search = url.searchParams.toString();
  return proxyToApi(
    request,
    `/admin/plugins/marketplace/catalog${search ? `?${search}` : ""}`
  );
}
