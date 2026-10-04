import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createServer, type IncomingMessage, type Server } from "http";
import type { Duplex } from "stream";
import * as jwt from "jsonwebtoken";
import { WebSocketServer, WebSocket } from "ws";
import { PrismaService } from "../prisma/prisma.service";
import { EnvComputeService } from "../compute/env-compute.service";
import type { ShellSession } from "../compute/env-compute-driver";
import type { BridgeJwtPayload } from "../auth/jwt.strategy";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

/** Min gap between env activity touches while a shell session is open. */
const ACTIVITY_TOUCH_INTERVAL_MS = 60_000;

/**
 * WebSocket terminal — browser xterm.js ↔ this handler ↔ a shell inside one
 * of the env's containers, opened through the env's compute driver
 * (`docker exec` locally; ECS ExecuteCommand on Fargate).
 *
 * URL: `ws://<api-host>/api/terminal/<envId>/<containerNameOrId>?token=<jwt>`
 * Auth: the same INTERNAL_JWT_SECRET used for HTTP requests. The browser
 * gets a short-lived token from Next (`GET /api/terminal/ws-token`) and
 * passes it via query string because browsers can't set custom headers on
 * WebSocket handshakes.
 */
@Injectable()
export class TerminalService {
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    @InjectPinoLogger(TerminalService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly compute: EnvComputeService,
    private readonly config: ConfigService
  ) {}

  /**
   * Attach the upgrade handler to the given Node HTTP server.
   * Called from main.ts after Nest's express instance is bound.
   */
  attach(server: Server): void {
    server.on("upgrade", (req, socket, head) => {
      const url = req.url || "";
      if (!url.startsWith("/api/terminal/")) {
        // Not ours — let Nest or the framework handle it (WS gateways, etc.)
        return;
      }
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
    const tag = `[terminal-ws] ${req.url}`;

    // Expected: /api/terminal/<envId>/<container>[?token=...]
    const parsed = new URL(req.url || "", "http://x");
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 4 || parts[0] !== "api" || parts[1] !== "terminal") {
      this.reject(socket, 404, "Not Found");
      return;
    }
    const envId = parts[2];
    const containerKey = decodeURIComponent(parts[3]);

    // Auth — bridge JWT in query string.
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

    // Env exists + user is a workspace member.
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.deletedAt) {
      this.reject(socket, 404, "Environment not found");
      return;
    }
    const member = await this.prisma.client.workspaceMember.findUnique({
      where: {
        workspaceId_userId: { workspaceId: env.workspaceId, userId },
      },
    });
    if (!member) {
      this.reject(socket, 403, "Forbidden");
      return;
    }

    // The driver resolves the container within this env only, so a shell can
    // never be opened into another env's container.
    const driver = await this.compute.driverFor(envId);
    const shell = await driver.openShell(envId, containerKey, {
      cols: 80,
      rows: 24,
    });
    if (!shell) {
      this.reject(socket, 404, "Container not running in this environment");
      return;
    }

    this.logger.info(
      `${tag} — opening shell in ${containerKey} for user ${userId}`
    );
    try {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.bridge(ws, shell, envId);
      });
    } catch (err) {
      // Upgrade failed after the shell was already opened — don't leak it.
      try {
        shell.kill();
      } catch {}
      throw err;
    }
  }

  private reject(socket: Duplex, code: number, reason: string) {
    try {
      socket.write(
        `HTTP/1.1 ${code} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      );
      socket.destroy();
    } catch {}
  }

  private bridge(ws: WebSocket, shell: ShellSession, envId: string): void {
    // Someone typing in a shell is using the env, even if the chat is idle.
    // Throttled so a key-by-key stream doesn't hammer the DB.
    let lastTouch = 0;
    const touch = () => {
      const now = Date.now();
      if (now - lastTouch < ACTIVITY_TOUCH_INTERVAL_MS) return;
      lastTouch = now;
      void this.compute.touchActivity(envId);
    };
    touch();

    shell.onData((data) => {
      try {
        ws.send(data);
      } catch {}
    });

    shell.onExit(({ exitCode, signal }) => {
      try {
        ws.send(
          `\r\n[shell exited code=${exitCode} signal=${signal ?? "-"}]\r\n`
        );
      } catch {}
      try {
        ws.close();
      } catch {}
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      touch();
      if (isBinary) {
        shell.write(data.toString("utf-8"));
        return;
      }
      try {
        const ev = JSON.parse(data.toString("utf-8"));
        if (ev && ev.type === "resize") {
          const cols = Math.max(10, Math.min(500, Number(ev.cols) || 80));
          const rows = Math.max(5, Math.min(200, Number(ev.rows) || 24));
          shell.resize(cols, rows);
        }
      } catch {
        shell.write(data.toString("utf-8"));
      }
    });

    ws.on("close", () => {
      try {
        shell.kill();
      } catch {}
    });
    ws.on("error", () => {
      try {
        shell.kill();
      } catch {}
    });
  }

  // Silence unused-import warnings if createServer isn't referenced.
  private _unused() {
    void createServer;
  }
}
