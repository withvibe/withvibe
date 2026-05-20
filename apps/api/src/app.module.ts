import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { LoggerModule } from "nestjs-pino";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HealthController } from "./health.controller";
import { AuthModule } from "./auth/auth.module";
import { CliAuthModule } from "./cli-auth/cli-auth.module";
import { PrismaModule } from "./prisma/prisma.module";
import { CommonModule } from "./common/common.module";
import { WorkspacesModule } from "./workspaces/workspaces.module";
import { AccountModule } from "./account/account.module";
import { MembersModule } from "./members/members.module";
import { InvitationsModule } from "./invitations/invitations.module";
import { ReposModule } from "./repos/repos.module";
import { EnvCloneModule } from "./env-clones/env-clone.module";
import { StorageModule } from "./storage/storage.module";
import { AgentSeedModule } from "./agents/agent-seed.module";
import { EnvsModule } from "./envs/envs.module";
import { DockerModule } from "./docker/docker.module";
import { PortsModule } from "./ports/ports.module";
import { TemplatesModule } from "./templates/templates.module";
import { AgentsModule } from "./agents/agents.module";
import { ChatModule } from "./chat/chat.module";
import { TerminalModule } from "./terminal/terminal.module";
import { GitModule } from "./git/git.module";
import { McpBridgeModule } from "./mcp-bridge/mcp-bridge.module";
import { RunnerModule } from "./runner/runner.module";
import { SlackModule } from "./slack/slack.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { SessionRotationInterceptor } from "./auth/session-rotation.interceptor";
import { RequestContextInterceptor } from "./common/request-context.interceptor";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", ".env.local"],
    }),
    // Structured logging via pino. Every log line is JSON in prod (grep-able
    // by jq); pretty-printed in dev for readability. pino-http auto-logs
    // each request once at completion with method/url/status/duration plus
    // any custom props attached during the request (see `customProps`).
    // Existing `new Logger(SvcName)` calls from @nestjs/common get routed
    // through pino because main.ts calls `app.useLogger(app.get(PinoLogger))`.
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL || "info",
        // X-Request-Id forwarded by upstream proxies wins; else generate.
        genReqId: (req: IncomingMessage) => {
          const hdr = req.headers["x-request-id"];
          if (typeof hdr === "string" && hdr.length > 0 && hdr.length <= 128) {
            return hdr;
          }
          return randomUUID();
        },
        // /health is hit by the load balancer and the web container's
        // readiness gate — keep it out of the access log so signal-to-noise
        // stays high.
        autoLogging: {
          ignore: (req: IncomingMessage) =>
            req.url === "/api/health" ||
            req.url === "/health" ||
            req.url === "/api/health/me",
        },
        // Don't dump the entire request/response — just the fields useful for
        // postmortems. Keeps each line small enough to be readable.
        serializers: {
          req: (req: IncomingMessage & { id?: string }) => ({
            id: req.id,
            method: req.method,
            url: req.url,
          }),
          res: (res: ServerResponse) => ({
            statusCode: res.statusCode,
          }),
        },
        transport:
          process.env.NODE_ENV === "production"
            ? undefined
            : {
                target: "pino-pretty",
                options: {
                  singleLine: true,
                  colorize: true,
                  translateTime: "HH:MM:ss.l",
                  ignore: "pid,hostname",
                },
              },
      },
    }),
    PrismaModule,
    CommonModule,
    AuthModule,
    CliAuthModule,
    WorkspacesModule,
    AccountModule,
    MembersModule,
    InvitationsModule,
    ReposModule,
    EnvCloneModule,
    StorageModule,
    AgentSeedModule,
    PortsModule,
    TemplatesModule,
    EnvsModule,
    DockerModule,
    AgentsModule,
    ChatModule,
    TerminalModule,
    GitModule,
    McpBridgeModule,
    RunnerModule,
    SlackModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    // Order matters: RequestContextInterceptor must run AFTER the auth guard
    // populates req.user but is fine running before session rotation. Nest
    // runs interceptors in the order they're declared here.
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestContextInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: SessionRotationInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  // nestjs-pino's pino-http handles request logging now — see LoggerModule
  // above. No explicit middleware wiring needed.
  configure(_consumer: MiddlewareConsumer) {
    // intentionally empty
  }
}
