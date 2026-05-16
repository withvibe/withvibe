import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { InvitationsService } from "./invitations.service";

/** Workspace-scoped invitation creation — admin only. */
@Controller("workspaces/:workspaceId/invitations")
@UseGuards(JwtAuthGuard)
export class WorkspaceInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Body() body: { email?: unknown; role?: unknown }
  ) {
    return this.invitations.create(user.id, workspaceId, body);
  }
}

/**
 * Token-scoped invitation routes.
 * - `GET /invitations/:token` is **public** (anyone with the link can preview).
 * - `POST /invitations/:token/accept` requires auth (need a user to attach).
 */
@Controller("invitations/:token")
export class TokenInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get()
  lookup(@Param("token") token: string) {
    return this.invitations.lookup(token);
  }

  @Post("accept")
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  accept(@CurrentUser() user: AuthUser, @Param("token") token: string) {
    return this.invitations.accept(user.id, token);
  }
}
