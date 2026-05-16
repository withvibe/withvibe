import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

export async function GET(request: NextRequest) {
  return proxyToApi(request, "/account");
}

export async function PATCH(request: NextRequest) {
  return proxyToApi(request, "/account");
}
