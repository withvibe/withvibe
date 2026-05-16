import { Global, Module } from "@nestjs/common";
import { WorkspaceAccessService } from "./workspace-access.service";
import { StartupCleanupService } from "./startup-cleanup.service";

@Global()
@Module({
  providers: [WorkspaceAccessService, StartupCleanupService],
  exports: [WorkspaceAccessService],
})
export class CommonModule {}
