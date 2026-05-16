import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { CliOrJwtAuthGuard } from "../auth/cli-or-jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { EnvsService } from "./envs.service";

// Top-level route — the CLI only holds envId, not workspaceId, so this
// lives outside the workspace-scoped EnvsController. The CLI authenticates
// with its bearer token; a logged-in browser session works too.
@Controller("envs")
@UseGuards(CliOrJwtAuthGuard)
export class LocalEnvBundleController {
  constructor(private readonly envs: EnvsService) {}

  @Get(":envId/local-bundle")
  localBundle(
    @CurrentUser() user: AuthUser,
    @Param("envId") envId: string
  ) {
    return this.envs.localBundle(user.id, envId);
  }

  @Get(":envId/export-readiness")
  exportReadiness(
    @CurrentUser() user: AuthUser,
    @Param("envId") envId: string
  ) {
    return this.envs.exportReadiness(user.id, envId);
  }
}
