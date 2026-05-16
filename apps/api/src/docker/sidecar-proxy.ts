import { Injectable, Logger } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as http from "node:http";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Request, Response, RequestHandler } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { PrismaService } from "../prisma/prisma.service";
import { CodeServerService } from "./code-server.service";
import { DbViewerService } from "./db-viewer.service";
import { SESSION_COOKIE_NAME } from "../auth/auth.service";
import type { BridgeJwtPayload } from "../auth/jwt.strategy";

type Route = {
  prefix: string; // e.g. "/api/code-server/view/"
  ws: boolean; // code-server needs WebSocket upgrades; Adminer doesn't
  target: (envId: string) => Promise<string | null>; // "host:port" or null
};

// Connection-level headers that must not be forwarded across a proxy hop.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Transparent same-origin reverse proxy for the code-server and Adminer
 * sidecars — the missing piece those features were already assuming exists
 * ("the published port goes through the API's reverse proxy which gates on
 * the user's session"). Without it they handed the browser
 * http://127.0.0.1:<port>, i.e. the *browser's* own loopback, so they only
 * ever worked when the api ran on the same machine as the browser.
 *
 *   /api/code-server/view/<envId>/...  → code-server (HTTP + WS)
 *   /api/db-viewer/view/<envId>/...    → Adminer (HTTP)
 *
 * The prefix is stripped before forwarding; both apps emit relative URLs so
 * the browser keeps the prefix on subsequent requests (the standard
 * subpath-reverse-proxy contract — same as the documented nginx recipe).
 * In production a Traefik path-prefix router sends these to api:4000; the
 * controllers only hand out these paths when the api runs in a container
 * (deployed) — on the dev host they still return the direct loopback URL,
 * which needs no proxy.
 */
@Injectable()
export class SidecarProxy {
  private readonly logger = new Logger(SidecarProxy.name);
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly routes: Route[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly codeServer: CodeServerService,
    private readonly dbViewer: DbViewerService
  ) {
    this.routes = [
      {
        prefix: "/api/code-server/view/",
        ws: true,
        target: (id) => this.codeServer.getProxyTarget(id),
      },
      {
        prefix: "/api/db-viewer/view/",
        ws: false,
        target: (id) => this.dbViewer.getProxyTarget(id),
      },
    ];
  }

  // ── HTTP ──────────────────────────────────────────────────────────────

  middleware(): RequestHandler {
    return (req, res, next) => {
      const route = this.routes.find((r) => req.path.startsWith(r.prefix));
      if (!route) return next();
      void this.handleHttp(route, req, res).catch((err) => {
        this.logger.error(`proxy error ${req.path}: ${err}`);
        if (!res.headersSent) res.status(502).send("Sidecar proxy error");
      });
    };
  }

  private async handleHttp(
    route: Route,
    req: Request,
    res: Response
  ): Promise<void> {
    const parsed = this.parse(route, req.path);
    if (!parsed) {
      res.status(404).send("Not found");
      return;
    }
    const { envId, rest, needsSlash } = parsed;

    const userId = this.authUserId(this.bearerOrCookie(req));
    if (!userId || !(await this.isMember(envId, userId))) {
      res.status(userId ? 403 : 401).send(userId ? "Forbidden" : "Unauthorized");
      return;
    }

    // The app serves relative URLs, so it must be reached from a path that
    // ends in "/" or every asset resolves one level too high.
    if (needsSlash) {
      const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
      res.redirect(302, `${route.prefix}${envId}/${q}`);
      return;
    }

    const target = await route.target(envId);
    if (!target) {
      res.status(409).send("This viewer is not running for this env");
      return;
    }

    const [host, portStr] = target.split(":");
    const query = req.url.includes("?")
      ? req.url.slice(req.url.indexOf("?"))
      : "";
    const upstreamPath = (rest || "/") + query;

    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v as string | string[];
    }
    headers["host"] = `${host}:${portStr}`;
    headers["x-forwarded-proto"] = (req.headers["x-forwarded-proto"] ||
      req.protocol) as string;
    headers["x-forwarded-host"] = (req.headers["x-forwarded-host"] ||
      req.headers["host"] ||
      "") as string;

    const upstream = http.request(
      {
        host,
        port: Number(portStr),
        method: req.method,
        path: upstreamPath,
        headers,
      },
      (up) => {
        res.status(up.statusCode || 502);
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined) continue;
          const lk = k.toLowerCase();
          if (HOP_BY_HOP.has(lk)) continue;
          if (lk === "set-cookie") {
            res.setHeader(
              "set-cookie",
              this.rescopeCookies(v as string[], `${route.prefix}${envId}/`)
            );
          } else if (lk === "location") {
            res.setHeader(
              "location",
              this.rewriteLocation(v as string, route.prefix, envId)
            );
          } else {
            res.setHeader(k, v as string | string[]);
          }
        }
        up.pipe(res);
      }
    );
    upstream.on("error", (err) => {
      this.logger.warn(`${route.prefix}${envId} upstream error: ${err.message}`);
      if (!res.headersSent) res.status(502).send("Sidecar unreachable");
      else res.destroy();
    });
    // Stream the (unparsed) request body straight through.
    req.pipe(upstream);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const url = req.url || "";
      const route = this.routes.find((r) => r.ws && url.startsWith(r.prefix));
      if (!route) return;
      void this.handleUpgrade(route, req, socket as Duplex, head).catch(
        (err) => {
          this.logger.error(`ws upgrade error: ${err}`);
          try {
            socket.destroy();
          } catch {}
        }
      );
    });
  }

  private async handleUpgrade(
    route: Route,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    const parsed = this.parse(route, (req.url || "").split("?")[0]);
    if (!parsed || parsed.needsSlash) {
      this.rejectWs(socket, 404, "Not Found");
      return;
    }
    const { envId, rest } = parsed;

    // Same-origin upgrade — the browser sends the session cookie itself.
    const cookieToken = this.cookieFromHeader(req.headers.cookie);
    const userId = this.authUserId(cookieToken);
    if (!userId || !(await this.isMember(envId, userId))) {
      this.rejectWs(socket, userId ? 403 : 401, "Unauthorized");
      return;
    }

    const target = await route.target(envId);
    if (!target) {
      this.rejectWs(socket, 409, "Viewer not running");
      return;
    }

    const query = (req.url || "").includes("?")
      ? (req.url || "").slice((req.url || "").indexOf("?"))
      : "";
    const upstreamUrl = `ws://${target}${rest || "/"}${query}`;
    const subproto = req.headers["sec-websocket-protocol"];
    const upstream = new WebSocket(
      upstreamUrl,
      typeof subproto === "string"
        ? subproto.split(",").map((s) => s.trim())
        : undefined
    );
    upstream.binaryType = "nodebuffer";

    this.wss.handleUpgrade(req, socket, head, (client) => {
      client.binaryType = "nodebuffer";
      const pending: Array<[Buffer, boolean]> = [];
      let open = false;

      const closeBoth = () => {
        try {
          client.close();
        } catch {}
        try {
          upstream.close();
        } catch {}
      };

      upstream.on("open", () => {
        open = true;
        for (const [d, bin] of pending.splice(0)) {
          try {
            upstream.send(d, { binary: bin });
          } catch {}
        }
      });
      upstream.on("message", (d, bin) => {
        try {
          client.send(d as Buffer, { binary: bin });
        } catch {}
      });
      upstream.on("close", closeBoth);
      upstream.on("error", (e) => {
        this.logger.warn(`${route.prefix}${envId} ws upstream: ${e.message}`);
        closeBoth();
      });

      client.on("message", (d, bin) => {
        const buf = d as Buffer;
        if (!open) {
          pending.push([buf, bin]);
          return;
        }
        try {
          upstream.send(buf, { binary: bin });
        } catch {}
      });
      client.on("close", closeBoth);
      client.on("error", closeBoth);
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /** Split "<prefix><envId>[/<rest>]"; flag the trailing-slash redirect. */
  private parse(
    route: Route,
    path: string
  ): { envId: string; rest: string; needsSlash: boolean } | null {
    const tail = path.slice(route.prefix.length);
    const slash = tail.indexOf("/");
    if (slash === -1) {
      const envId = decodeURIComponent(tail);
      return envId ? { envId, rest: "", needsSlash: true } : null;
    }
    const envId = decodeURIComponent(tail.slice(0, slash));
    if (!envId) return null;
    return { envId, rest: tail.slice(slash), needsSlash: false };
  }

  private bearerOrCookie(req: Request): string | undefined {
    const cookies = (req as Request & { cookies?: Record<string, string> })
      .cookies;
    const fromCookie = cookies?.[SESSION_COOKIE_NAME];
    const header = req.headers.authorization;
    const fromHeader = header?.startsWith("Bearer ")
      ? header.slice(7)
      : undefined;
    return fromCookie || fromHeader;
  }

  private cookieFromHeader(cookie: string | undefined): string | undefined {
    if (!cookie) return undefined;
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
    return undefined;
  }

  private authUserId(token: string | undefined): string | null {
    if (!token) return null;
    try {
      const p = this.jwt.verify<BridgeJwtPayload>(token);
      return p?.userId ?? null;
    } catch {
      return null;
    }
  }

  private async isMember(envId: string, userId: string): Promise<boolean> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.deletedAt) return false;
    const m = await this.prisma.client.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: env.workspaceId, userId },
      },
    });
    return !!m;
  }

  /** Keep each env's sidecar cookies scoped to its own proxied path. */
  private rescopeCookies(setCookies: string[], basePath: string): string[] {
    return setCookies.map((c) => {
      if (/;\s*path=/i.test(c)) {
        return c.replace(/;\s*path=[^;]*/i, `; Path=${basePath}`);
      }
      return `${c}; Path=${basePath}`;
    });
  }

  /** Re-add the prefix to root-absolute redirects so they stay in-app. */
  private rewriteLocation(
    loc: string,
    prefix: string,
    envId: string
  ): string {
    if (loc.startsWith("/") && !loc.startsWith("//")) {
      return `${prefix}${envId}${loc}`;
    }
    return loc;
  }

  private rejectWs(socket: Duplex, code: number, msg: string): void {
    try {
      socket.write(
        `HTTP/1.1 ${code} ${msg}\r\nContent-Length: ${msg.length}\r\n` +
          `Connection: close\r\n\r\n${msg}`
      );
    } catch {}
    try {
      socket.destroy();
    } catch {}
  }
}
