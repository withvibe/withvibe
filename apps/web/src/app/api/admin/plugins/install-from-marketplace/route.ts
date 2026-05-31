import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(request: NextRequest) {
  return proxyToApi(request, "/admin/plugins/install-from-marketplace");
}
