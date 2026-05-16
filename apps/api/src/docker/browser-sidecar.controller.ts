import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { BrowserSidecarService } from "./browser-sidecar.service";

type Action = "start" | "stop";

@Controller("workspaces/:workspaceId/envs/:envId/qa-browser")
@UseGuards(JwtAuthGuard)
export class BrowserSidecarController {
  constructor(
    private readonly sidecar: BrowserSidecarService,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  // GET — read-only status. The frontend "QA Browser" tab polls this to
  // decide whether to render the iframe or a "not yet running" placeholder.
  @Get()
  async status(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    await this.assertEnv(user.id, workspaceId, envId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        qaBrowserStatus: true,
        qaBrowserCdpPort: true,
        qaBrowserVncPort: true,
        qaBrowserError: true,
      },
    });
    return {
      status: env?.qaBrowserStatus ?? "stopped",
      port: env?.qaBrowserVncPort ?? null,
      // Same-origin path to our custom noVNC viewer (served + WS-relayed by
      // QaViewHttpProxy / QaViewGateway). Relative so it works on any host —
      // the old hardcoded http://127.0.0.1:<port> pointed at the *browser's*
      // own loopback, which is why it failed on remote deploys.
      viewerUrl:
        env?.qaBrowserStatus === "running"
          ? `/api/qa-browser/view/${envId}`
          : null,
      error: env?.qaBrowserError ?? null,
    };
  }

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
      await this.sidecar.stop(envId);
      return { ok: true };
    }

    const result = await this.sidecar.start(envId);
    if (!result.ok) {
      throw new HttpException(result.error, 409);
    }
    return {
      ok: true,
      port: result.vncPort,
      viewerUrl: `/api/qa-browser/view/${envId}`,
    };
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
