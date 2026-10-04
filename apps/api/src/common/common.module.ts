import { Global, Module } from "@nestjs/common";
import { WorkspaceAccessService } from "./workspace-access.service";
import { StartupCleanupService } from "./startup-cleanup.service";
import { DemoModeService } from "./demo-mode.service";
import { SaasModeService } from "./saas-mode.service";

@Global()
@Module({
  providers: [
    WorkspaceAccessService,
    StartupCleanupService,
    DemoModeService,
    SaasModeService,
  ],
  exports: [WorkspaceAccessService, DemoModeService, SaasModeService],
})
export class CommonModule {}
