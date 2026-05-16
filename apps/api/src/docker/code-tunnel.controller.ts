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
import { CodeTunnelService } from "./code-tunnel.service";

type Action = "start" | "stop";

@Controller("workspaces/:workspaceId/envs/:envId/code-tunnel")
@UseGuards(JwtAuthGuard)
export class CodeTunnelController {
  constructor(
    private readonly tunnel: CodeTunnelService,
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
      await this.tunnel.stop(user.id, envId);
      return { ok: true };
    }

    const result = await this.tunnel.start(user.id, envId);
    if (result.status === "running") {
      return {
        ok: true,
        status: "running",
        tunnelName: result.tunnelName,
        vscodeUri: result.vscodeUri,
        vscodeDevUrl: result.vscodeDevUrl,
      };
    }
    if (result.status === "needs_auth") {
      // 202 — the tunnel can't start until the user completes the device-code
      // login flow. Web UI shows the URL+code.
      return {
        ok: false,
        status: "needs_auth",
        loginUrl: result.loginUrl,
        loginCode: result.loginCode,
      };
    }
    throw new HttpException(result.error, 409);
  }

  // Used by the web UI to poll while the user finishes the device-code flow.
  @Get("auth-status")
  async authStatus(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    await this.assertEnv(user.id, workspaceId, envId);
    return this.tunnel.authStatus(user.id);
  }

  // Wipe stored auth — forces a fresh login next time.
  @Post("logout")
  async logout(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    await this.assertEnv(user.id, workspaceId, envId);
    return this.tunnel.logout(user.id);
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
