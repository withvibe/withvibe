import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EnvLogBufferService } from "./env-log-buffer.service";
import { LocalDockerDriver } from "./local-docker.driver";
import { EnvComputeService } from "./env-compute.service";
import { AwsClientsService } from "./fargate/aws-clients.service";
import { AwsConnectionService } from "./fargate/aws-connection.service";
import { AwsConnectionController } from "./fargate/aws-connection.controller";
import { FargatePublicController } from "./fargate/fargate-public.controller";
import { TraefikDynamicService } from "./fargate/traefik-dynamic.service";
import { FargateExecService } from "./fargate/fargate-exec.service";
import { FargateDriver } from "./fargate/fargate.driver";
import { FargateReaperService } from "./fargate/fargate-reaper.service";

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
  controllers: [AwsConnectionController, FargatePublicController],
  providers: [
    EnvLogBufferService,
    LocalDockerDriver,
    AwsClientsService,
    AwsConnectionService,
    TraefikDynamicService,
    FargateExecService,
    FargateDriver,
    EnvComputeService,
    FargateReaperService,
  ],
  exports: [
    EnvLogBufferService,
    EnvComputeService,
    AwsConnectionService,
    FargateExecService,
  ],
})
export class ComputeModule {}
