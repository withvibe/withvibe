import { Module } from "@nestjs/common";
import { WorkspacesModule } from "../workspaces/workspaces.module";
import { EnvsModule } from "../envs/envs.module";
import { DemoProvisionService } from "./demo-provision.service";

/**
 * Demo-mode cross-cutting services. Imports Workspaces + Envs so provisioning
 * can reuse their create() flows. DemoModeService itself lives in the global
 * CommonModule, so it's injectable here without an explicit import.
 */
@Module({
  imports: [WorkspacesModule, EnvsModule],
  providers: [DemoProvisionService],
  exports: [DemoProvisionService],
})
export class DemoModule {}
