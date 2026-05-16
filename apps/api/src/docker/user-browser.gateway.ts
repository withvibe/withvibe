import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type IncomingMessage, type Server } from "http";
import type { Duplex } from "stream";
import * as jwt from "jsonwebtoken";
import { WebSocketServer, WebSocket } from "ws";
import { PrismaService } from "../prisma/prisma.service";
import { UserBrowserBridgeService } from "./user-browser.service";
import type { BridgeJwtPayload } from "../auth/jwt.strategy";

/**
 * WebSocket gateway for the WithVibe QA browser Chrome extension.
 *
 *   wss?://<api-host>/api/qa-browser/ws/<envId>?token=<jwt>
 *
 * The user mints a short-lived bridge JWT from `POST /qa-browser/ws-token`,
 * pastes it into the extension popup, and the extension uses it as the
 * `?token=` query param. We verify the same `INTERNAL_JWT_SECRET` used for
 * HTTP auth, then hand the connection to `UserBrowserBridgeService` which
 * tracks (envId, userId) → socket pairings and dispatches RPC.
 *
 * Mirrors the auth pattern from `TerminalService`.
 */
@Injectable()
export class UserBrowserGateway {
  private readonly logger = new Logger(UserBrowserGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    private readonly prisma: PrismaService,
    private readonly bridge: UserBrowserBridgeService,
    private readonly config: ConfigService
  ) {}

  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const url = req.url || "";
      if (!url.startsWith("/api/qa-browser/ws/")) return;
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
    const tag = `[qa-browser-ws] ${req.url}`;
    const parsed = new URL(req.url || "", "http://x");
    const parts = parsed.pathname.split("/").filter(Boolean);
    // Expected: ["api", "qa-browser", "ws", "<envId>"]
    if (
      parts.length < 4 ||
      parts[0] !== "api" ||
      parts[1] !== "qa-browser" ||
      parts[2] !== "ws"
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
      select: { workspaceId: true, deletedAt: true, qaBrowserMode: true },
    });
    if (!env || env.deletedAt) {
      this.reject(socket, 404, "Env not found");
      return;
    }
    if (env.qaBrowserMode !== "user_browser") {
      this.reject(
        socket,
        409,
        "This env's QA browser mode is not 'user_browser' — change it from the env settings panel before pairing the extension."
      );
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

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.bindSocket({ ws, envId, userId: userId! });
    });
  }

  private bindSocket(args: {
    ws: WebSocket;
    envId: string;
    userId: string;
  }): void {
    const { ws, envId, userId } = args;
    this.bridge.registerPairing({ envId, userId, socket: ws });
    ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf-8");
      this.bridge.handleMessage({ envId, userId, socket: ws, raw: text });
    });
    const teardown = () =>
      this.bridge.removePairing({ envId, userId, socket: ws });
    ws.on("close", teardown);
    ws.on("error", (err) => {
      this.logger.warn(
        `qa-browser ws error env=${envId} user=${userId}: ${err.message}`
      );
      teardown();
    });

    // Tell the extension what it's paired to so its popup can render context.
    try {
      ws.send(
        JSON.stringify({
          type: "paired",
          envId,
          userId,
        })
      );
    } catch {
      // best-effort
    }
  }

  private reject(socket: Duplex, code: number, message: string): void {
    try {
      socket.write(
        `HTTP/1.1 ${code} ${message}\r\n` +
          `Content-Length: ${message.length}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
          message
      );
    } catch {
      // best-effort
    }
    try {
      socket.destroy();
    } catch {
      // best-effort
    }
  }
}
