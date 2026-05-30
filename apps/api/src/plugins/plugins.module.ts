import { Global, Logger, Module, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PluginManifest } from "./manifest";
import { PluginMcpBridgeService } from "./plugin-mcp-bridge.service";
import { PluginPostgresService } from "./plugin-postgres.service";
import { PluginsAdminController } from "./plugins-admin.controller";
import { PluginsController } from "./plugins.controller";
import { PluginsService } from "./plugins.service";

// Phase-1 validation fixture. Tiny nginx container that serves a hello
// page on port 80 — proves the spawn → health → proxy → iframe rails end
// to end without needing a developer to ship one. Production deployments
// opt out with WITHVIBE_DISABLE_SAMPLE_PLUGIN=true.
const SAMPLE_PLUGIN = {
  id: "withvibe.sample.hello",
  name: "Hello Sample",
  version: "1.0.0",
  icon: "puzzle",
  image: "nginxdemos/hello:latest",
  launch: {
    port: 80,
    healthPath: "/",
    env: {},
  },
  ui: {
    iframePath: "/",
    needsWebsocket: false,
  },
  permissions: [],
};

@Global()
@Module({
  controllers: [PluginsController, PluginsAdminController],
  providers: [PluginsService, PluginPostgresService, PluginMcpBridgeService],
  exports: [PluginsService, PluginPostgresService, PluginMcpBridgeService],
})
export class PluginsModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(PluginsModule.name);

  constructor(
    private readonly plugins: PluginsService,
    private readonly config: ConfigService
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedSamplePlugin();
    await this.registerAllRoutes();
  }

  private async seedSamplePlugin(): Promise<void> {
    const disable = this.config.get<string>("WITHVIBE_DISABLE_SAMPLE_PLUGIN");
    if (disable === "true" || disable === "1") return;
    const manifest = PluginManifest.parse(SAMPLE_PLUGIN);
    await this.plugins.upsertManifestForSeed(manifest);
    this.logger.log(
      `Seeded sample plugin ${manifest.id} (set WITHVIBE_DISABLE_SAMPLE_PLUGIN=true to skip).`
    );
  }

  /**
   * Re-register every enabled plugin's proxy route with SidecarProxy on
   * boot. Phase 2's admin install/enable flows call PluginsService.
   * registerRoute() at action time so the routing table converges without
   * a restart.
   */
  private async registerAllRoutes(): Promise<void> {
    const enabled = await this.plugins.listEnabled();
    for (const { manifest } of enabled) {
      this.plugins.registerRoute(manifest);
    }
    this.logger.log(
      `Registered ${enabled.length} plugin proxy route(s) with SidecarProxy.`
    );
  }
}
