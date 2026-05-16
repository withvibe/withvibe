import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { DbViewerService } from "./db-viewer.service";

type Action = "start" | "stop";

@Controller("workspaces/:workspaceId/envs/:envId/db-viewer")
@UseGuards(JwtAuthGuard)
export class DbViewerController {
  constructor(
    private readonly viewer: DbViewerService,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  @Post()
  async action(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { action?: unknown }
  ) {
    await this.assertEnv(user.id, workspaceId, envId);
    const action = body?.action as Action | undefined;
    if (!action || !["start", "stop"].includes(action)) {
      throw new BadRequestException("action must be 'start' or 'stop'");
    }

    if (action === "stop") {
      await this.viewer.stop(envId);
      return { ok: true };
    }

    const result = await this.viewer.start(envId);
    if (!result.ok) {
      // 409 — the env state doesn't permit starting the viewer (e.g. stopped,
      // no DBs detected). Not a server error; the client can show the message.
      throw new HttpException(result.error, 409);
    }
    // Same-origin proxied path when the api is containerized (Traefik routes
    // /api/db-viewer/view/ → api → reverse proxy → Adminer); direct loopback
    // URL on a dev host. Replaces the old hardcoded http://127.0.0.1:<port>
    // (the browser's own loopback → broke on remote deploys).
    const url = await this.viewer.viewerUrl(envId);
    return { ok: true, port: result.port, url };
  }

  private async assertEnv(
    userId: string,
    workspaceId: string,
    envId: string
  ) {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
  }
}
