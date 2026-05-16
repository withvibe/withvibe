import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createServer, type IncomingMessage, type Server } from "http";
import type { Duplex } from "stream";
import { execFile } from "child_process";
import { promisify } from "util";
import * as jwt from "jsonwebtoken";
import { WebSocketServer, WebSocket } from "ws";
import * as pty from "node-pty";
import { PrismaService } from "../prisma/prisma.service";
import { DockerService } from "../docker/docker.service";
import type { BridgeJwtPayload } from "../auth/jwt.strategy";

const exec = promisify(execFile);

/**
 * WebSocket terminal — browser xterm.js ↔ this handler ↔ `docker exec sh`.
 *
 * URL: `ws://<api-host>/api/terminal/<envId>/<containerNameOrId>?token=<jwt>`
 * Auth: the same INTERNAL_JWT_SECRET used for HTTP requests. The browser
 * gets a short-lived token from Next (`GET /api/terminal/ws-token`) and
 * passes it via query string because browsers can't set custom headers on
 * WebSocket handshakes.
 */
@Injectable()
export class TerminalService {
  private readonly logger = new Logger(TerminalService.name);
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    private readonly prisma: PrismaService,
    private readonly docker: DockerService,
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

    // Container must belong to the env's compose project.
    const project = this.docker.composeProjectName(envId);
    const targetId = await this.resolveContainer(project, containerKey);
    if (!targetId) {
      this.reject(socket, 404, "Container not running in this environment");
      return;
    }

    this.logger.log(
      `${tag} — opening shell in ${targetId.slice(0, 12)} for user ${userId}`
    );
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.openShell(ws, targetId);
    });
  }

  private reject(socket: Duplex, code: number, reason: string) {
    try {
      socket.write(
        `HTTP/1.1 ${code} ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`
      );
      socket.destroy();
    } catch {}
  }

  private async resolveContainer(
    project: string,
    key: string
  ): Promise<string | null> {
    try {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "--filter",
          `label=com.docker.compose.project=${project}`,
          "--format",
          "{{.ID}}\t{{.Names}}",
        ],
        { timeout: 10_000 }
      );
      const candidates = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, name] = line.split("\t");
          return { id, name };
        });
      const match = candidates.find(
        (c) => c.id === key || c.id.startsWith(key) || c.name === key
      );
      return match ? match.id : null;
    } catch {
      return null;
    }
  }

  private openShell(ws: WebSocket, containerId: string): void {
    const shell = pty.spawn(
      "docker",
      [
        "exec",
        "-it",
        containerId,
        "sh",
        "-c",
        "command -v bash >/dev/null && exec bash -l || exec sh -l",
      ],
      {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env as { [key: string]: string },
      }
    );

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
