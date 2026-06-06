import { Global, Logger, Module, OnApplicationBootstrap } from "@nestjs/common";
import { PluginMcpBridgeService } from "./plugin-mcp-bridge.service";
import { PluginPostgresService } from "./plugin-postgres.service";
import { PluginsAdminController } from "./plugins-admin.controller";
import { PluginsController } from "./plugins.controller";
import { PluginsService } from "./plugins.service";

@Global()
@Module({
  controllers: [PluginsController, PluginsAdminController],
  providers: [PluginsService, PluginPostgresService, PluginMcpBridgeService],
  exports: [PluginsService, PluginPostgresService, PluginMcpBridgeService],
})
export class PluginsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(PluginsModule.name);

  constructor(private readonly plugins: PluginsService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.registerAllRoutes();
  }

  /**
   * Re-register every enabled plugin's proxy route with SidecarProxy on
   * boot. The admin install/enable flows call PluginsService.registerRoute()
   * at action time so the routing table converges without a restart.
   * listEnabled() already skips rows whose stored manifest doesn't parse
   * (legacy schemas etc.), so a broken plugin never crashes boot.
   */
  private async registerAllRoutes(): Promise<void> {
    const enabled = await this.plugins.listEnabled();
    for (const { id, manifest } of enabled) {
      this.plugins.registerRoute(id, manifest);
    }
    this.logger.log(
      `Registered ${enabled.length} plugin proxy route(s) with SidecarProxy.`
    );
  }
}
