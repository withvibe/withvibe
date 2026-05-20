import { Module } from "@nestjs/common";
import { EnvsController } from "./envs.controller";
import { EnvsService } from "./envs.service";
import { EnvAssetsController } from "./env-assets.controller";
import { EnvAssetsService } from "./env-assets.service";
import { EnvContextController } from "./env-context.controller";
import { EnvContextService } from "./env-context.service";
import { LocalEnvBundleController } from "./local-bundle.controller";
import { TemplatesModule } from "../templates/templates.module";
import { RunnerModule } from "../runner/runner.module";
import { ChatModule } from "../chat/chat.module";

@Module({
  imports: [TemplatesModule, RunnerModule, ChatModule],
  controllers: [
    EnvsController,
    EnvAssetsController,
    EnvContextController,
    LocalEnvBundleController,
  ],
  providers: [EnvsService, EnvAssetsService, EnvContextService],
  exports: [EnvsService, EnvAssetsService, EnvContextService],
})
export class EnvsModule {}
