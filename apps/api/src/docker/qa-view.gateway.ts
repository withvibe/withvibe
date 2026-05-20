import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type IncomingMessage, type Server } from "http";
import type { Duplex } from "stream";
import * as jwt from "jsonwebtoken";
import { WebSocketServer, WebSocket } from "ws";
import { PrismaService } from "../prisma/prisma.service";
import { BrowserSidecarService } from "./browser-sidecar.service";
import type { BridgeJwtPayload } from "../auth/jwt.strategy";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/**
 * WebSocket relay for the QA-browser noVNC viewer.
 *
 *   wss?://<same-origin>/api/qa-browser/view-ws/<envId>?token=<jwt>
 *
 * The browser loads our custom RFB page (served by
 * `BrowserSidecarController` under /api/qa-browser/view/<envId>/), which
 * opens this WS. We verify the short-lived bridge JWT (same secret as HTTP
 * auth — browsers can't set headers on a WS handshake, so it rides the
 * query string) plus workspace membership, then splice the socket onto the
 * sidecar's websockify (:7900) so RFB frames flow end to end.
 *
 * Mirrors the auth pattern from `UserBrowserGateway` / `TerminalService`.
 * Same-origin in production: a Traefik path-prefix router sends
 * /api/qa-browser/view-ws/ straight to api:4000, bypassing Next.js.
 */
@Injectable()
export class QaViewGateway {
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    @InjectPinoLogger(QaViewGateway.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly sidecar: BrowserSidecarService,
    private readonly config: ConfigService
  ) {}

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const url = req.url || "";
      if (!url.startsWith("/api/qa-browser/view-ws/")) return;
      void this.handleUpgrade(req, socket as Duplex, head).catch((err) => {
        this.logger.error(`upgrade error: ${err}`);
        try {
          socket.destroy();
        } catch {}
      });
    });
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    const tag = `[qa-view-ws] ${req.url}`;
    const parsed = new URL(req.url || "", "http://x");
    const parts = parsed.pathname.split("/").filter(Boolean);
    // Expected: ["api", "qa-browser", "view-ws", "<envId>"]
    if (
      parts.length < 4 ||
      parts[0] !== "api" ||
      parts[1] !== "qa-browser" ||
      parts[2] !== "view-ws"
    ) {
      this.reject(socket, 404, "Not Found");
      return;
    }
    const envId = parts[3];

    const token = parsed.searchParams.get("token");
    const secret = this.config.get<string>("INTERNAL_JWT_SECRET");
    if (!token || !secret) {
      this.logger.warn(`${tag} — missing token or secret`);
      this.reject(socket, 401, "Unauthorized");
      return;
    }
    let userId: string | null = null;
    try {
      const payload = jwt.verify(token, secret, {
        algorithms: ["HS256"],
      }) as BridgeJwtPayload;
      userId = payload.userId;
    } catch {
      this.reject(socket, 401, "Unauthorized");
      return;
    }
    if (!userId) {
      this.reject(socket, 401, "Unauthorized");
      return;
    }

    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.deletedAt) {
      this.reject(socket, 404, "Env not found");
      return;
    }
    const member = await this.prisma.client.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: env.workspaceId, userId },
      },
    });
    if (!member) {
      this.reject(socket, 403, "Not a member of this workspace");
      return;
    }

    const target = await this.sidecar.getNoVncTarget(envId);
    if (!target) {
      this.reject(socket, 409, "QA browser is not running for this env");
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.relay(ws, target, envId);
    });
  }

  /**
   * Splice the browser WS onto the sidecar's websockify. websockify upgrades
   * any path, so the upstream path is irrelevant; we relay binary RFB frames
   * verbatim in both directions and tear both sides down together.
   */
  private relay(client: WebSocket, target: string, envId: string): void {
    const upstream = new WebSocket(`ws://${target}/`);
    upstream.binaryType = "nodebuffer";
    client.binaryType = "nodebuffer";

    // Buffer anything RFB sends before the upstream handshake completes —
    // noVNC starts talking the moment its socket opens.
    const pending: Buffer[] = [];
    let upstreamOpen = false;

    const closeBoth = (code?: number, reason?: string) => {
      try {
        client.close(code, reason);
      } catch {}
      try {
        upstream.close();
      } catch {}
    };

    upstream.on("open", () => {
      upstreamOpen = true;
      for (const buf of pending.splice(0)) {
        try {
          upstream.send(buf);
        } catch {}
      }
    });
    upstream.on("message", (data) => {
      try {
        client.send(data as Buffer, { binary: true });
      } catch {}
    });
    upstream.on("close", () => closeBoth());
    upstream.on("error", (err) => {
      this.logger.warn(`${envId}: upstream noVNC error: ${err.message}`);
      closeBoth(1011, "upstream error");
    });

    client.on("message", (data) => {
      const buf = data as Buffer;
      if (!upstreamOpen) {
        pending.push(buf);
        return;
      }
      try {
        upstream.send(buf);
      } catch {}
    });
    client.on("close", () => closeBoth());
    client.on("error", () => closeBoth());
  }

  private reject(socket: Duplex, code: number, message: string): void {
    try {
      socket.write(
        `HTTP/1.1 ${code} ${message}\r\n` +
          `Content-Length: ${message.length}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
          message
      );
    } catch {}
    try {
      socket.destroy();
    } catch {}
  }
}
