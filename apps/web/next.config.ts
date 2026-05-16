import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Resolve this file's directory without relying on CJS __dirname — Next 16
// loads next.config.ts as an ES module. Pinning turbopack.root here is
// important in a monorepo, otherwise Next guesses wrong.
const here = path.dirname(fileURLToPath(import.meta.url));
// Point turbopack.root at the monorepo root (apps/web/../..) so it can
// resolve hoisted dependencies. Per Next 16 docs:
// https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory
const monorepoRoot = path.resolve(here, "..", "..");

// In dev the web app and the NestJS API run on different ports. In
// production they sit behind the same reverse proxy, so these rewrites are
// dev-only — paths under /api/auth/*, /api/cli-auth/*, /api/terminal/* and
// the new bootstrap endpoints get forwarded to NestJS so the browser keeps
// using same-origin URLs (and the session cookie travels untouched).
const apiBase = process.env.API_BASE_URL || "http://localhost:4000";

const nextConfig: NextConfig = {
  // Self-contained build for the Docker runtime stage — Next emits
  // .next/standalone/server.js plus only the deps it actually traces.
  output: "standalone",
  // Trace from the monorepo root so hoisted/workspace deps are picked up.
  outputFileTracingRoot: monorepoRoot,
  turbopack: {
    root: monorepoRoot,
  },
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${apiBase}/api/auth/:path*` },
      {
        source: "/api/cli-auth/:path*",
        destination: `${apiBase}/api/cli-auth/:path*`,
      },
      {
        source: "/api/terminal/ws-token",
        destination: `${apiBase}/api/terminal/ws-token`,
      },
      // QA-browser noVNC viewer page + its proxied asset tree. Dev-only:
      // in production Traefik routes /api/qa-browser/view/ straight to the
      // api (compose-rewriter label), so this rewrite never fires there.
      // The noVNC WebSocket (/api/qa-browser/view-ws/) is intentionally NOT
      // rewritten — Next.js can't proxy WS upgrades; the viewer page opens
      // it directly against the resolved api origin instead.
      {
        source: "/api/qa-browser/view/:path*",
        destination: `${apiBase}/api/qa-browser/view/:path*`,
      },
      // Adminer (DB viewer) reverse proxy. Dev-only (Traefik handles prod).
      // Plain HTTP, no WebSocket, so unlike code-server it proxies cleanly
      // through Next here. code-server is intentionally absent: its
      // workbench WS can't traverse a Next rewrite, so on the dev host it
      // uses the direct loopback URL instead.
      {
        source: "/api/db-viewer/view/:path*",
        destination: `${apiBase}/api/db-viewer/view/:path*`,
      },
    ];
  },
};

export default nextConfig;
