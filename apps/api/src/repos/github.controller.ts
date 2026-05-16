import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { GithubService } from "./github.service";

@Controller("workspaces/:workspaceId/github")
@UseGuards(JwtAuthGuard)
export class GithubController {
  constructor(private readonly github: GithubService) {}

  @Get("repos")
  repos(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    return this.github.listUserRepos(user.id, workspaceId);
  }
}
