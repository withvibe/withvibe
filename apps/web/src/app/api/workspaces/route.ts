import { NextRequest } from "next/server";
import { proxyToApi } from "@/lib/proxy-to-api";

// POST /api/workspaces — create a new workspace.
// Proxied to NestJS (@withvibe/api).
export async function POST(request: NextRequest) {
  return proxyToApi(request, "/workspaces");
}
