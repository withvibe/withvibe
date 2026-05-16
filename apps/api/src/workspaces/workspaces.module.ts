import { Module } from "@nestjs/common";
import { WorkspacesController } from "./workspaces.controller";
import { WorkspacesService } from "./workspaces.service";
import { SecretsService } from "./secrets.service";
import { ReposModule } from "../repos/repos.module";

@Module({
  imports: [ReposModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, SecretsService],
  exports: [WorkspacesService, SecretsService],
})
export class WorkspacesModule {}
