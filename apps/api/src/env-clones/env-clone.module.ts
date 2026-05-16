import { Global, Module } from "@nestjs/common";
import { EnvCloneService } from "./env-clone.service";
import { CodeWorkspaceService } from "./code-workspace.service";

@Global()
@Module({
  providers: [EnvCloneService, CodeWorkspaceService],
  exports: [EnvCloneService, CodeWorkspaceService],
})
export class EnvCloneModule {}
