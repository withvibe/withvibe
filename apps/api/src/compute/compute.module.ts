import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EnvLogBufferService } from "./env-log-buffer.service";
import { LocalDockerDriver } from "./local-docker.driver";
import { EnvComputeService } from "./env-compute.service";
import { AwsClientsService } from "./fargate/aws-clients.service";
import { AwsConnectionService } from "./fargate/aws-connection.service";
import { AwsConnectionController } from "./fargate/aws-connection.controller";
import { TraefikDynamicService } from "./fargate/traefik-dynamic.service";
import { FargateDriver } from "./fargate/fargate.driver";

/**
 * The compute-target seam: per-env driver resolution (local docker, Fargate)
 * plus the target-agnostic lifecycle log buffer, plus the per-workspace
 * client-AWS-account connection the Fargate driver runs against. Global for
 * the same reason DockerModule is — the env lifecycle is reached from
 * controllers, MCP servers, chat, and terminal alike.
 */
@Global()
@Module({
  imports: [AuthModule],
  controllers: [AwsConnectionController],
  providers: [
    EnvLogBufferService,
    LocalDockerDriver,
    AwsClientsService,
    AwsConnectionService,
    TraefikDynamicService,
    FargateDriver,
    EnvComputeService,
  ],
  exports: [EnvLogBufferService, EnvComputeService, AwsConnectionService],
})
export class ComputeModule {}
