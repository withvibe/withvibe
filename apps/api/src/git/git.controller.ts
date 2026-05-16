import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { GitService } from "./git.service";

@Controller("workspaces/:workspaceId/envs/:envId/git")
@UseGuards(JwtAuthGuard)
export class GitController {
  constructor(private readonly git: GitService) {}

  @Get("summary")
  summary(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.git.envSummary(user.id, workspaceId, envId);
  }

  @Get("repos/:envRepoId/status")
  status(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string
  ) {
    return this.git.repoStatus(user.id, workspaceId, envId, envRepoId);
  }

  @Get("repos/:envRepoId/diff")
  diff(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string
  ) {
    return this.git.repoDiff(user.id, workspaceId, envId, envRepoId);
  }

  @Get("repos/:envRepoId/history")
  history(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string
  ) {
    return this.git.repoHistory(user.id, workspaceId, envId, envRepoId);
  }

  @Post("repos/:envRepoId/commit")
  commit(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string,
    @Body() body: { message?: string; paths?: string[] }
  ) {
    return this.git.commit(
      user.id,
      workspaceId,
      envId,
      envRepoId,
      body?.message ?? "",
      Array.isArray(body?.paths) ? body.paths : undefined
    );
  }

  @Post("repos/:envRepoId/push")
  push(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string
  ) {
    return this.git.push(user.id, workspaceId, envId, envRepoId);
  }

  @Post("repos/:envRepoId/merge")
  merge(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string
  ) {
    return this.git.mergeToBase(user.id, workspaceId, envId, envRepoId);
  }

  @Post("repos/:envRepoId/pr")
  pr(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string,
    @Body() body: { title?: string; body?: string }
  ) {
    return this.git.createPullRequest(
      user.id,
      workspaceId,
      envId,
      envRepoId,
      body || {}
    );
  }

  @Post("repos/:envRepoId/suggest-message")
  suggest(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string
  ) {
    return this.git.suggestCommitMessage(
      user.id,
      workspaceId,
      envId,
      envRepoId
    );
  }

  @Post("all/commit")
  commitAll(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { message?: string }
  ) {
    return this.git.commitAll(
      user.id,
      workspaceId,
      envId,
      body?.message ?? ""
    );
  }

  @Post("all/push")
  pushAll(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.git.pushAll(user.id, workspaceId, envId);
  }

  @Post("repos/:envRepoId/pull")
  pull(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string,
    @Body() body: { mode?: "auto-stash" | "discard"; confirmDiscard?: boolean }
  ) {
    return this.git.pull(user.id, workspaceId, envId, envRepoId, body || {});
  }

  @Post("all/pull")
  pullAll(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { mode?: "auto-stash" | "discard"; confirmDiscard?: boolean }
  ) {
    return this.git.pullAll(user.id, workspaceId, envId, body || {});
  }

  @Post("repos/:envRepoId/recover")
  recover(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("envRepoId") envRepoId: string,
    @Body() body: { backupRef?: string }
  ) {
    return this.git.recoverFromBackup(
      user.id,
      workspaceId,
      envId,
      envRepoId,
      body?.backupRef ?? ""
    );
  }
}
