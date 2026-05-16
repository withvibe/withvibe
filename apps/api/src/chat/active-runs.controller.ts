import { Controller, Get, Param, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import {
  ActiveRunsService,
  type WorkspaceRunEvent,
} from "./active-runs.service";

/**
 * Workspace-level visibility into active agent runs, for:
 *   - the env list "agent running" indicator
 *   - completion notifications from the workspace shell
 *
 * Per-env detail (message events, transcripts) still goes through
 * MessagesController at /envs/:envId/messages/active-run*.
 */
@Controller("workspaces/:workspaceId/active-runs")
@UseGuards(JwtAuthGuard)
export class ActiveRunsController {
  constructor(
    private readonly activeRuns: ActiveRunsService,
    private readonly access: WorkspaceAccessService
  ) {}

  /** Snapshot — env IDs that currently have at least one running session. */
  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ): Promise<{ envIds: string[] }> {
    await this.access.member(user.id, workspaceId);
    return { envIds: this.activeRuns.listRunningEnvs(workspaceId) };
  }

  /** SSE of run_started / run_ended events for the workspace. */
  @Get("stream")
  async stream(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Res() res: Response
  ) {
    await this.access.member(user.id, workspaceId);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as unknown as { flushHeaders: () => void }).flushHeaders();
    }

    const write = (ev: WorkspaceRunEvent | { type: "snapshot"; envIds: string[] }) => {
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        // Client gone.
      }
    };

    // Seed with a snapshot so the client can render state immediately without
    // a separate GET round-trip.
    write({ type: "snapshot", envIds: this.activeRuns.listRunningEnvs(workspaceId) });

    const unsubscribe = this.activeRuns.subscribeWorkspace(workspaceId, write);

    // Keepalive — stops proxies from killing the idle connection.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: keepalive\n\n`);
      } catch {
        // Swallow — close handler will clean up.
      }
    }, 15_000);

    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {}
    };
    res.on("close", close);
    res.on("error", close);
  }
}
