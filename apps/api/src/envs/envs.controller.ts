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
import { EnvsService } from "./envs.service";

@Controller("workspaces/:workspaceId/envs")
@UseGuards(JwtAuthGuard)
export class EnvsController {
  constructor(private readonly envs: EnvsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    return this.envs.list(user.id, workspaceId);
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Body()
    body: {
      title?: unknown;
      description?: unknown;
      repos?: unknown;
      composeFile?: unknown;
      templateId?: unknown;
      templateVars?: unknown;
      qaBrowserMode?: unknown;
    }
  ) {
    return this.envs.create(user.id, workspaceId, body);
  }

  @Get(":envId")
  detail(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.envs.detail(user.id, workspaceId, envId);
  }

  @Patch(":envId")
  update(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body()
    body: {
      title?: unknown;
      description?: unknown;
      status?: unknown;
      composeFile?: unknown;
      repos?: unknown;
      chatEngine?: unknown;
      qaBrowserMode?: unknown;
      modelChoice?: unknown;
      sandboxBypass?: unknown;
    }
  ) {
    return this.envs.update(user.id, workspaceId, envId, body);
  }

  @Delete(":envId")
  delete(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.envs.delete(user.id, workspaceId, envId);
  }
}
