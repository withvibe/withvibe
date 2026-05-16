import { proxyToApi } from "@/lib/proxy-to-api";

export async function POST(req: Request) {
  return proxyToApi(req, "/qa-browser/ws-token");
}
