import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { DemoModeService } from "../common/demo-mode.service";
import { ReposService } from "./repos.service";

@Controller("workspaces/:workspaceId/repos")
@UseGuards(JwtAuthGuard)
export class ReposController {
  constructor(
    private readonly repos: ReposService,
    private readonly demo: DemoModeService
  ) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    return this.repos.list(user.id, workspaceId);
  }

  @Post()
  @HttpCode(201)
  async add(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Body() body: { url?: unknown; branch?: unknown }
  ) {
    if (this.demo.enabled) {
      throw new ForbiddenException("Adding repositories is disabled in demo mode");
    }
    const url = typeof body.url === "string" ? body.url.trim() : "";
    if (!url) throw new BadRequestException("URL is required");
    const branch =
      typeof body.branch === "string" && body.branch.trim()
        ? body.branch.trim()
        : null;
    return this.repos.add(user.id, workspaceId, url, branch);
  }

  @Patch(":repoId")
  update(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("repoId") repoId: string,
    @Body() body: { defaultForNewEnvs?: unknown }
  ) {
    return this.repos.update(user.id, workspaceId, repoId, body);
  }

  @Delete(":repoId")
  delete(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("repoId") repoId: string
  ) {
    return this.repos.delete(user.id, workspaceId, repoId);
  }

  @Post(":repoId/retry")
  @HttpCode(200)
  retry(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("repoId") repoId: string
  ) {
    return this.repos.retry(user.id, workspaceId, repoId);
  }

  @Get(":repoId/branches")
  branches(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("repoId") repoId: string
  ) {
    return this.repos.listRemoteBranches(user.id, workspaceId, repoId);
  }
}
