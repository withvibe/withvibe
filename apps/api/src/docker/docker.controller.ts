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
import { EnvComputeService } from "../compute/env-compute.service";
import { EnvLogBufferService } from "../compute/env-log-buffer.service";
import type { LogStreamHandle } from "../compute/env-compute-driver";

type Action = "start" | "stop" | "rebuild";
type ServiceAction = "start" | "stop" | "restart" | "rebuild";

// Compose service names: lowercase letters, digits, underscore, hyphen.
// Validating here keeps the name out of `docker compose` argv unsanitized.
const SERVICE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Container lifecycle + live logs. One controller per route so the SSE
 * endpoint's decorator doesn't affect the others.
 */
@Controller("workspaces/:workspaceId/envs/:envId/container")
@UseGuards(JwtAuthGuard)
export class DockerContainerController {
  constructor(
    private readonly compute: EnvComputeService,
    private readonly logBuffer: EnvLogBufferService,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  @Post()
  async action(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { action?: unknown; service?: unknown }
  ) {
    await this.assertEnv(user.id, workspaceId, envId);
    const driver = await this.compute.driverFor(envId);
    const action = body?.action;
    const rawService = body?.service;
    const service =
      typeof rawService === "string" ? rawService.trim() : "";

    if (service) {
      // Per-service lifecycle. Adds `restart` on top of the env-level set;
      // the env doesn't have a meaningful single-call "restart" today.
      if (
        typeof action !== "string" ||
        !["start", "stop", "restart", "rebuild"].includes(action)
      ) {
        throw new BadRequestException(
          "action must be one of: start, stop, restart, rebuild"
        );
      }
      if (!SERVICE_NAME_RE.test(service)) {
        throw new BadRequestException("invalid service name");
      }
      await driver.serviceAction(envId, service, action as ServiceAction);
      return { ok: true };
    }

    // Env-level action (existing behavior).
    if (
      typeof action !== "string" ||
      !["start", "stop", "rebuild"].includes(action)
    ) {
      throw new BadRequestException(
        "action must be one of: start, stop, rebuild"
      );
    }
    const envAction = action as Action;
    if (envAction === "start") await driver.startEnvironment(envId);
    else if (envAction === "stop") await driver.stopEnvironment(envId);
    else await driver.rebuildEnvironment(envId);
    return { ok: true };
  }

  /** SSE log stream — combines in-memory build-log buffer + the driver's
   * runtime log follow (`docker compose logs -f` locally). */
  @Sse("logs")
  async logs(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ): Promise<Observable<{ data: { type: string; text?: string; error?: string } }>> {
    await this.assertEnv(user.id, workspaceId, envId);
    const driver = await this.compute.driverFor(envId);

    return new Observable((subscriber) => {
      let closed = false;
      const send = (event: { type: string; text?: string; error?: string }) => {
        if (!closed) subscriber.next({ data: event });
      };

      // 1) Subscribe to the in-memory build/lifecycle log buffer.
      const unsubscribe = this.logBuffer.subscribe(envId, (chunk) => {
        send({ type: "log", text: chunk });
      });

      // 2) Follow the running containers' stdout through the driver.
      let stream: LogStreamHandle | null = null;
      void (async () => {
        const opened = await driver.streamRuntimeLogs(envId, (text) =>
          send({ type: "log", text })
        );
        if ("error" in opened) {
          if (!closed) send({ type: "error", error: opened.error });
          return;
        }
        if (closed) {
          // Unsubscribed before the stream opened — close it.
          opened.close();
          return;
        }
        stream = opened;
      })();

      return () => {
        closed = true;
        unsubscribe();
        try {
          stream?.close();
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
    const driver = await this.compute.driverFor(envId);
    return driver.listEnvContainers(envId);
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
