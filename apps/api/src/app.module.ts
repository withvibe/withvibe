import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
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
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { HttpLoggerMiddleware } from "./common/http-logger.middleware";
import { SessionRotationInterceptor } from "./auth/session-rotation.interceptor";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", ".env.local"],
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
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: SessionRotationInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpLoggerMiddleware).forRoutes("*");
  }
}
