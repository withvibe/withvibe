import { Global, Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DockerService } from "./docker.service";
import { DockerContainerController } from "./docker.controller";
import { DbViewerService } from "./db-viewer.service";
import { DbViewerController } from "./db-viewer.controller";
import { DockerMcpService } from "./docker-mcp.service";
import { BrowserSidecarService } from "./browser-sidecar.service";
import { BrowserSidecarController } from "./browser-sidecar.controller";
import { QaViewGateway } from "./qa-view.gateway";
import { QaViewHttpProxy } from "./qa-view.http-proxy";
import { SidecarProxy } from "./sidecar-proxy";
import { PlaywrightMcpService } from "./playwright-mcp.service";
import { UserBrowserBridgeService } from "./user-browser.service";
import { UserBrowserController } from "./user-browser.controller";
import { UserBrowserGateway } from "./user-browser.gateway";
import { CodeServerService } from "./code-server.service";
import { CodeServerController } from "./code-server.controller";
import { CodeTunnelService } from "./code-tunnel.service";
import { CodeTunnelController } from "./code-tunnel.controller";

@Global()
@Module({
  imports: [AuthModule],
  controllers: [
    DockerContainerController,
    DbViewerController,
    BrowserSidecarController,
    UserBrowserController,
    CodeServerController,
    CodeTunnelController,
  ],
  providers: [
    DockerService,
    DbViewerService,
    DockerMcpService,
    BrowserSidecarService,
    QaViewGateway,
    QaViewHttpProxy,
    SidecarProxy,
    PlaywrightMcpService,
    UserBrowserBridgeService,
    UserBrowserGateway,
    CodeServerService,
    CodeTunnelService,
  ],
  exports: [
    DockerService,
    DbViewerService,
    DockerMcpService,
    BrowserSidecarService,
    QaViewGateway,
    QaViewHttpProxy,
    SidecarProxy,
    PlaywrightMcpService,
    UserBrowserBridgeService,
    UserBrowserGateway,
    CodeServerService,
    CodeTunnelService,
  ],
})
export class DockerModule {}
