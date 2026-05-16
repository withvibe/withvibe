import {
  Body,
  Controller,
  Delete,
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
import { SessionsService } from "./sessions.service";

@Controller("workspaces/:workspaceId/envs/:envId/sessions")
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.sessions.list(user.id, workspaceId, envId);
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { title?: unknown; agentId?: unknown }
  ) {
    return this.sessions.create(user.id, workspaceId, envId, body);
  }

  @Patch(":sessionId")
  rename(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("sessionId") sessionId: string,
    @Body() body: { title?: unknown }
  ) {
    return this.sessions.rename(user.id, workspaceId, envId, sessionId, body);
  }

  @Delete(":sessionId")
  delete(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("sessionId") sessionId: string
  ) {
    return this.sessions.delete(user.id, workspaceId, envId, sessionId);
  }
}
