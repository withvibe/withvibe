import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { UserBrowserBridgeService } from "./user-browser.service";

/**
 * REST surface for the user-browser pairing flow:
 *  - `POST /qa-browser/ws-token` mints the short-lived JWT the extension uses
 *    to authenticate its WebSocket. Mirrors `TerminalController.issue`.
 *  - `GET /workspaces/:wid/envs/:eid/qa-browser/extension` reports whether
 *    the speaker has a paired extension for this env (used by the QA Browser
 *    panel's user-browser sub-view).
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class UserBrowserController {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly bridge: UserBrowserBridgeService,
    private readonly config: ConfigService
  ) {}

  @Post("qa-browser/ws-token")
  @HttpCode(HttpStatus.OK)
  async issueWsToken(
    @CurrentUser() user: AuthUser,
    @Body() body: { envId?: string } | undefined
  ) {
    if (!body?.envId) {
      throw new NotFoundException("envId required");
    }
    const env = await this.prisma.client.env.findUnique({
      where: { id: body.envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.deletedAt) throw new NotFoundException("Env not found");
    await this.access.member(user.id, env.workspaceId);

    // 5 minutes is enough for a human to copy/paste into the extension popup.
    // The token is checked once at WS handshake; thereafter the connection
    // stays open as long as the extension wants it to.
    const token = this.jwt.sign(
      { userId: user.id, email: user.email },
      { expiresIn: "5m" }
    );
    // API_PUBLIC_URL is the value the installer sets on a domain deploy
    // (= https://<domain>). Without it this fell through to localhost:4000
    // and the pairing URL pointed the extension at its own machine. The
    // Traefik path-prefix router now forwards /api/qa-browser/ws/ to
    // api:4000, so the public domain is a valid WS origin.
    const apiBaseUrl =
      this.config.get<string>("PUBLIC_API_BASE_URL") ||
      this.config.get<string>("API_BASE_URL") ||
      this.config.get<string>("API_PUBLIC_URL") ||
      "http://localhost:4000";
    const apiUrl = new URL(apiBaseUrl);
    const wsProto = apiUrl.protocol === "https:" ? "wss:" : "ws:";
    const pairingUrl = `${wsProto}//${apiUrl.host}/api/qa-browser/ws/${body.envId}?token=${encodeURIComponent(token)}`;
    return { token, apiBaseUrl, pairingUrl };
  }

  @Get("workspaces/:workspaceId/envs/:envId/qa-browser/extension")
  async status(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    await this.access.member(user.id, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
    return this.bridge.status({ envId, userId: user.id });
  }
}
