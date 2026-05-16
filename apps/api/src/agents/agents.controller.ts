import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  AgentsService,
  type CreateAgentInput,
  type UpdateAgentInput,
} from "./agents.service";

/** Workspace-scoped agent details + CRUD. */
@Controller("workspaces/:workspaceId/agents")
@UseGuards(JwtAuthGuard)
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    return this.agents.listForWorkspace(user.id, workspaceId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Body() body: CreateAgentInput
  ) {
    return this.agents.create(user.id, workspaceId, body);
  }

  @Post("clone")
  createClone(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    return this.agents.createClone(user.id, workspaceId);
  }

  @Get(":agentId")
  detail(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("agentId") agentId: string,
    @Query("envId") envId?: string
  ) {
    return this.agents.detail(user.id, workspaceId, agentId, envId ?? null);
  }

  @Patch(":agentId")
  update(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("agentId") agentId: string,
    @Body() body: UpdateAgentInput
  ) {
    return this.agents.update(user.id, workspaceId, agentId, body);
  }

  @Delete(":agentId")
  remove(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("agentId") agentId: string
  ) {
    return this.agents.remove(user.id, workspaceId, agentId);
  }
}

/** Env-scoped agent list + enable/disable toggle per env. */
@Controller("workspaces/:workspaceId/envs/:envId/agents")
@UseGuards(JwtAuthGuard)
export class EnvAgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.agents.listForEnv(user.id, workspaceId, envId);
  }

  @Put(":agentId/disabled")
  setDisabled(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("agentId") agentId: string,
    @Body() body: { disabled: boolean }
  ) {
    return this.agents.setEnvDisabled(
      user.id,
      workspaceId,
      envId,
      agentId,
      !!body.disabled
    );
  }
}
