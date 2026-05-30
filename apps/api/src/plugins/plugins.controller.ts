import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z, ZodError } from "zod";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthUser } from "../auth/jwt.strategy";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { PluginsService } from "./plugins.service";

const ToggleBody = z.object({ enabled: z.boolean() });

@Controller("workspaces/:workspaceId/envs/:envId/plugins")
@UseGuards(JwtAuthGuard)
export class PluginsController {
  constructor(
    private readonly plugins: PluginsService,
    private readonly access: WorkspaceAccessService
  ) {}

  @Get()
  async list(
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.member(user.id, workspaceId);
    const plugins = await this.plugins.listForEnv(envId, workspaceId);
    return { plugins };
  }

  @Post(":pluginId/start")
  async start(
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("pluginId") pluginId: string,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.member(user.id, workspaceId);
    return this.plugins.start(envId, pluginId, workspaceId);
  }

  @Post(":pluginId/stop")
  async stop(
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("pluginId") pluginId: string,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.member(user.id, workspaceId);
    return this.plugins.stopForEnvPage(pluginId, envId, workspaceId);
  }

  // ── per-env enable/disable (manage dialog) ────────────────────────────

  @Get("prefs")
  async listPrefs(
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.member(user.id, workspaceId);
    const prefs = await this.plugins.listPrefsForEnv(envId);
    return { prefs };
  }

  @Post(":pluginId/prefs")
  async setPref(
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("pluginId") pluginId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.member(user.id, workspaceId);
    let parsed: { enabled: boolean };
    try {
      parsed = ToggleBody.parse(body);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException(
          err.issues.map((i) => i.message).join("; ")
        );
      }
      throw err;
    }
    return this.plugins.setEnabledForEnv(
      envId,
      workspaceId,
      pluginId,
      parsed.enabled
    );
  }
}
