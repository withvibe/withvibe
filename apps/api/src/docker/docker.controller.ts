import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Sse,
  UseGuards,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { DockerService } from "./docker.service";

type Action = "start" | "stop" | "rebuild";

/**
 * Container lifecycle + live logs. One controller per route so the SSE
 * endpoint's decorator doesn't affect the others.
 */
@Controller("workspaces/:workspaceId/envs/:envId/container")
@UseGuards(JwtAuthGuard)
export class DockerContainerController {
  constructor(
    private readonly docker: DockerService,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  @Post()
  async action(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { action?: unknown }
  ) {
    await this.assertEnv(user.id, workspaceId, envId);
    const action = body?.action as Action | undefined;
    if (!action || !["start", "stop", "rebuild"].includes(action)) {
      throw new BadRequestException(
        "action must be one of: start, stop, rebuild"
      );
    }
    if (action === "start") await this.docker.startEnvironment(envId);
    else if (action === "stop") await this.docker.stopEnvironment(envId);
    else await this.docker.rebuildEnvironment(envId);
    return { ok: true };
  }

  /** SSE log stream — combines in-memory build-log buffer + `docker compose logs -f`. */
  @Sse("logs")
  async logs(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ): Promise<Observable<{ data: { type: string; text?: string; error?: string } }>> {
    await this.assertEnv(user.id, workspaceId, envId);

    return new Observable((subscriber) => {
      let closed = false;
      const send = (event: { type: string; text?: string; error?: string }) => {
        if (!closed) subscriber.next({ data: event });
      };

      // 1) Subscribe to the in-memory build/lifecycle log buffer.
      const unsubscribe = this.docker.subscribeLogs(envId, (chunk) => {
        send({ type: "log", text: chunk });
      });

      // 2) Spawn `docker compose logs -f` for running container stdout.
      let child: import("child_process").ChildProcess | null = null;
      void (async () => {
        const spawned = await this.docker.spawnLogProcess(envId);
        if (closed) {
          // Unsubscribed before spawn finished — kill it.
          if (!("error" in spawned)) spawned.child.kill("SIGTERM");
          return;
        }
        if ("error" in spawned) {
          send({ type: "error", error: spawned.error });
          return;
        }
        child = spawned.child;
        const onData = (buf: Buffer) =>
          send({ type: "log", text: buf.toString("utf-8") });
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("error", () => {});
      })();

      return () => {
        closed = true;
        unsubscribe();
        try {
          child?.kill("SIGTERM");
        } catch {}
      };
    });
  }

  @Get("containers")
  async containers(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    await this.assertEnv(user.id, workspaceId, envId);
    return this.docker.listEnvContainers(envId);
  }

  private async assertEnv(
    userId: string,
    workspaceId: string,
    envId: string
  ) {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
  }
}
