import { Global, Module } from "@nestjs/common";
import { WorkspaceAccessService } from "./workspace-access.service";
import { StartupCleanupService } from "./startup-cleanup.service";
import { DemoModeService } from "./demo-mode.service";

@Global()
@Module({
  providers: [WorkspaceAccessService, StartupCleanupService, DemoModeService],
  exports: [WorkspaceAccessService, DemoModeService],
})
export class CommonModule {}
