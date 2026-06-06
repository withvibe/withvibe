import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z, ZodError } from "zod";
import { CliOrJwtAuthGuard } from "../auth/cli-or-jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { PluginsService } from "./plugins.service";

const InstallBody = z.object({
  manifestText: z.string().min(1),
});
const InstallFromUrlBody = z.object({
  manifestUrl: z.string().url(),
});
const InstallFromMarketplaceBody = z.object({
  slug: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  version: z.string().min(1).max(40).optional(),
});
// PATCH accepts either field; at least one must be present. Lets admins
// flip the per-env default without touching `enabled` (and vice-versa).
const PatchBody = z
  .object({
    enabled: z.boolean().optional(),
    defaultEnabledInEnv: z.boolean().optional(),
  })
  .refine(
    (v) => v.enabled !== undefined || v.defaultEnabledInEnv !== undefined,
    { message: "Pass at least one of: enabled, defaultEnabledInEnv" }
  );

function parseBody<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BadRequestException(
        err.issues.map((i) => i.message).join("; ")
      );
    }
    throw err;
  }
}

// Plugins are installed per-workspace: each row is scoped to a workspace and
// only that workspace's admins may install/update/uninstall. The deployment-
// wide AdminGuard is gone; authority is the workspace-admin check below.
@Controller("workspaces/:workspaceId/admin/plugins")
@UseGuards(CliOrJwtAuthGuard)
export class PluginsAdminController {
  constructor(
    private readonly plugins: PluginsService,
    private readonly config: ConfigService,
    private readonly access: WorkspaceAccessService
  ) {}

  @Get()
  async list(
    @Param("workspaceId") workspaceId: string,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.admin(user.id, workspaceId);
    const plugins = await this.plugins.listAll(workspaceId);
    return { plugins };
  }

  // ── marketplace browsing (proxies the public catalog) ─────────────────

  private marketplaceBaseUrl(): string {
    const raw = this.config.get<string>("WITHVIBE_MARKETPLACE_BASE_URL");
    return (raw ?? "https://withvibe.dev").replace(/\/+$/, "");
  }

  @Get("marketplace/catalog")
  async marketplaceCatalog(
    @Param("workspaceId") workspaceId: string,
    @CurrentUser() user: AuthUser,
    @Query("q") q?: string,
    @Query("category") category?: string
  ) {
    await this.access.admin(user.id, workspaceId);
    const url = new URL(`${this.marketplaceBaseUrl()}/api/catalog`);
    if (q) url.searchParams.set("q", q);
    if (category) url.searchParams.set("category", category);
    const res = await fetch(url.toString(), {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new BadRequestException(
        `Marketplace fetch failed (HTTP ${res.status})`
      );
    }
    return res.json();
  }

  // Install by slug from the configured marketplace. Composes the manifest
  // URL server-side so the web side doesn't have to know the marketplace
  // base URL. The 1-click install button on the Marketplace tab uses this.
  @Post("install-from-marketplace")
  @HttpCode(HttpStatus.CREATED)
  async installFromMarketplace(
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.admin(user.id, workspaceId);
    const { slug, version } = parseBody(InstallFromMarketplaceBody, body);
    const base = this.marketplaceBaseUrl();
    const url = new URL(`${base}/api/catalog/${slug}/manifest.yaml`);
    if (version) url.searchParams.set("version", version);
    const manifestText = await this.fetchManifestText(url.toString());
    return this.plugins.install(workspaceId, manifestText, user.id);
  }

  // Install by arbitrary HTTPS URL (paste-URL flow for air-gapped or
  // self-hosted catalogs). Same install path as install-from-marketplace,
  // just without the slug composition.
  @Post("install-from-url")
  @HttpCode(HttpStatus.CREATED)
  async installFromUrl(
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.admin(user.id, workspaceId);
    const { manifestUrl } = parseBody(InstallFromUrlBody, body);
    const manifestText = await this.fetchManifestText(manifestUrl);
    return this.plugins.install(workspaceId, manifestText, user.id);
  }

  private async fetchManifestText(url: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/yaml, text/yaml, text/plain" },
      });
    } catch (err) {
      throw new BadRequestException(
        `Failed to reach manifest URL: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!res.ok) {
      throw new BadRequestException(
        `Failed to fetch manifest (HTTP ${res.status})`
      );
    }
    return res.text();
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async install(
    @Param("workspaceId") workspaceId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.admin(user.id, workspaceId);
    const { manifestText } = parseBody(InstallBody, body);
    return this.plugins.install(workspaceId, manifestText, user.id);
  }

  // GET /:pluginId — fetch the stored manifest so the admin editor can
  // preload it for the "Update" flow.
  @Get(":pluginId")
  async getOne(
    @Param("workspaceId") workspaceId: string,
    @Param("pluginId") pluginId: string,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.admin(user.id, workspaceId);
    return this.plugins.getManifestText(workspaceId, pluginId);
  }

  // POST /:pluginId/update — replace the stored manifest with a new one,
  // force-pull the image (so moving tags refresh), and stop running
  // instances so the next env start picks up the new image.
  @Post(":pluginId/update")
  @HttpCode(HttpStatus.OK)
  async update(
    @Param("workspaceId") workspaceId: string,
    @Param("pluginId") pluginId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.admin(user.id, workspaceId);
    const { manifestText } = parseBody(InstallBody, body);
    return this.plugins.update(workspaceId, pluginId, manifestText, user.id);
  }

  @Patch(":pluginId")
  async toggle(
    @Param("workspaceId") workspaceId: string,
    @Param("pluginId") pluginId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.admin(user.id, workspaceId);
    const { enabled, defaultEnabledInEnv } = parseBody(PatchBody, body);
    return this.plugins.updateAdminFlags(workspaceId, pluginId, {
      enabled,
      defaultEnabledInEnv,
    });
  }

  @Delete(":pluginId")
  @HttpCode(HttpStatus.OK)
  async uninstall(
    @Param("workspaceId") workspaceId: string,
    @Param("pluginId") pluginId: string,
    @CurrentUser() user: AuthUser
  ) {
    await this.access.admin(user.id, workspaceId);
    return this.plugins.uninstall(workspaceId, pluginId);
  }
}
