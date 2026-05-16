import { Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request, Response, RequestHandler } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { BrowserSidecarService } from "./browser-sidecar.service";
import { SESSION_COOKIE_NAME } from "../auth/auth.service";
import type { BridgeJwtPayload } from "../auth/jwt.strategy";

const PREFIX = "/api/qa-browser/view/";

/**
 * Reverse-proxies the QA-browser sidecar's noVNC over a same-origin path so
 * it works on remote deploys (the old code handed the browser a hardcoded
 * 127.0.0.1 URL — its own loopback, not the server's).
 *
 * Mounted as raw Express middleware from main.ts rather than a Nest route:
 * Express 5's path-to-regexp drops unnamed `*` wildcards, and proxying a
 * whole noVNC asset tree needs an arbitrary-suffix match. Doing it here
 * keeps the wildcard out of Nest's router entirely. Auth mirrors
 * `JwtStrategy` (session cookie or bearer) since the iframe loads
 * same-origin and the browser sends the `withvibe_session` cookie itself.
 *
 *   GET /api/qa-browser/view/<envId>            → custom RFB viewer page
 *   GET /api/qa-browser/view/<envId>/<asset...> → proxied to websockify :7900
 *
 * In production a Traefik path-prefix router sends /api/qa-browser/view/
 * straight to api:4000, bypassing Next.js.
 */
@Injectable()
export class QaViewHttpProxy {
  private readonly logger = new Logger(QaViewHttpProxy.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sidecar: BrowserSidecarService,
    private readonly jwt: JwtService
  ) {}

  /** `app.use(...)`-able handler; mounted from main.ts after cookieParser. */
  middleware(): RequestHandler {
    return (req, res, next) => {
      if (!req.path.startsWith(PREFIX)) return next();
      void this.handle(req, res).catch((err) => {
        this.logger.error(`view proxy error: ${err}`);
        if (!res.headersSent) res.status(502).send("QA view proxy error");
      });
    };
  }

  private async handle(req: Request, res: Response): Promise<void> {
    // PREFIX has a trailing slash; rest = "<envId>" or "<envId>/<asset...>"
    const rest = req.path.slice(PREFIX.length);
    const slash = rest.indexOf("/");
    const envId = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const assetPath = slash === -1 ? "" : rest.slice(slash + 1);
    if (!envId) {
      res.status(404).send("Not found");
      return;
    }

    const authed = this.authUser(req);
    if (!authed) {
      res.status(401).send("Unauthorized");
      return;
    }
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.deletedAt) {
      res.status(404).send("Env not found");
      return;
    }
    const member = await this.prisma.client.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: env.workspaceId, userId: authed.userId },
      },
    });
    if (!member) {
      res.status(403).send("Forbidden");
      return;
    }

    if (assetPath === "") {
      this.servePage(res, envId, authed);
      return;
    }

    const target = await this.sidecar.getNoVncTarget(envId);
    if (!target) {
      res.status(409).send("QA browser is not running for this env");
      return;
    }
    await this.proxyAsset(res, target, assetPath, req.url.split("?")[1]);
  }

  /** Resolve the user from the session cookie or a bearer token. */
  private authUser(
    req: Request
  ): { userId: string; email: string } | null {
    const cookies = (req as Request & { cookies?: Record<string, string> })
      .cookies;
    const fromCookie = cookies?.[SESSION_COOKIE_NAME];
    const header = req.headers.authorization;
    const fromHeader = header?.startsWith("Bearer ")
      ? header.slice(7)
      : undefined;
    const token = fromCookie || fromHeader;
    if (!token) return null;
    try {
      const payload = this.jwt.verify<BridgeJwtPayload>(token);
      if (!payload?.userId) return null;
      return { userId: payload.userId, email: payload.email ?? "" };
    } catch {
      return null;
    }
  }

  /**
   * A deliberately tiny noVNC client: it pulls RFB straight from the
   * proxied core/ tree and points it at our same-origin WS relay, so we
   * never depend on stock vnc.html's autoconnect query-param parsing.
   */
  private servePage(
    res: Response,
    envId: string,
    authed: { userId: string; email: string }
  ): void {
    // Short-lived token for the WS handshake (browsers can't set headers on
    // a WS upgrade). The connection is checked once at handshake; an hour is
    // plenty for a QA session and gets re-minted on every page (re)load.
    const wsToken = this.jwt.sign(
      { userId: authed.userId, email: authed.email },
      { expiresIn: "1h" }
    );
    const base = `${PREFIX}${encodeURIComponent(envId)}`;
    const wsUrl = this.viewWsUrl(envId, wsToken);
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QA Browser</title>
<style>
  html,body{margin:0;height:100%;background:#0b0b0c;overflow:hidden}
  #screen{width:100%;height:100%}
  #msg{position:absolute;inset:0;display:flex;align-items:center;
       justify-content:center;color:#9aa0a6;
       font:13px/1.4 system-ui,sans-serif;text-align:center;padding:1rem}
</style>
</head>
<body>
<div id="screen"></div>
<div id="msg">Connecting to QA browser…</div>
<script type="module">
  import RFB from "${base}/core/rfb.js";
  const msg = document.getElementById("msg");
  let rfb;
  try {
    rfb = new RFB(document.getElementById("screen"), ${JSON.stringify(wsUrl)});
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.addEventListener("connect", () => { msg.style.display = "none"; });
    rfb.addEventListener("disconnect", (e) => {
      msg.style.display = "flex";
      msg.textContent = e.detail && e.detail.clean
        ? "QA browser disconnected."
        : "Connection lost — the QA browser may have stopped.";
    });
  } catch (err) {
    msg.textContent = "Failed to start viewer: " + (err && err.message || err);
  }
</script>
</body>
</html>`;
    res.status(200);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.send(html);
  }

  /**
   * Absolute WS URL for the viewer's noVNC relay. Resolved from the api's
   * public base — same chain as TerminalController/UserBrowserController so
   * all three agree:
   *   - prod (domain install): API_PUBLIC_URL = https://<domain>; Traefik's
   *     path-prefix router sends /api/qa-browser/view-ws/ to api:4000.
   *   - dev (pnpm dev): falls through to http://localhost:4000, reached
   *     directly (the page is Next-rewritten, but Next can't proxy WS).
   */
  private viewWsUrl(envId: string, token: string): string {
    const apiBase =
      process.env.PUBLIC_API_BASE_URL ||
      process.env.API_BASE_URL ||
      process.env.API_PUBLIC_URL ||
      "http://localhost:4000";
    const u = new URL(apiBase);
    const proto = u.protocol === "https:" ? "wss:" : "ws:";
    return (
      `${proto}//${u.host}/api/qa-browser/view-ws/` +
      `${encodeURIComponent(envId)}?token=${encodeURIComponent(token)}`
    );
  }

  private async proxyAsset(
    res: Response,
    target: string,
    assetPath: string,
    query: string | undefined
  ): Promise<void> {
    const url = `http://${target}/${assetPath}${query ? `?${query}` : ""}`;
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(url);
    } catch (err) {
      res
        .status(502)
        .send(`noVNC upstream unreachable: ${(err as Error).message}`);
      return;
    }
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    // websockify's static server can mislabel ES modules; the browser hard
    // -refuses `import` on a non-JS MIME, so pin it by extension.
    if (/\.m?js$/.test(assetPath)) {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    } else if (ct) {
      res.setHeader("Content-Type", ct);
    }
    res.setHeader("Cache-Control", "no-store");
    const body = Buffer.from(await upstream.arrayBuffer());
    res.end(body);
  }
}
