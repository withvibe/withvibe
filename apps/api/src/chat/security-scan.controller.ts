import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { SecurityScanService } from "./security-scan.service";

@Controller("workspaces/:workspaceId/envs/:envId/security-scan")
@UseGuards(JwtAuthGuard)
export class SecurityScanController {
  constructor(private readonly scan: SecurityScanService) {}

  /**
   * The Security agent session for this env (or null if no scan was ever
   * run). The panel uses this to load the last report and reattach to a
   * running scan via the active-run endpoints.
   */
  @Get()
  latest(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.scan.latest(user.id, workspaceId, envId);
  }

  /** Start a scan. Returns `{ sessionId }` to subscribe the run stream. */
  @Post()
  start(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.scan.start(user.id, workspaceId, envId);
  }
}
