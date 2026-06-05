import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { DemoModeService } from "../common/demo-mode.service";
import { WorkspacesService } from "./workspaces.service";
import { SecretsService } from "./secrets.service";

@Controller("workspaces")
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly secrets: SecretsService,
    private readonly demo: DemoModeService
  ) {}

  /** Settings are read-only for public demo visitors. */
  private assertNotDemo() {
    if (this.demo.enabled) {
      throw new ForbiddenException(
        "Settings are read-only in demo mode"
      );
    }
  }

  @Post()
  @HttpCode(201)
  async create(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      name?: unknown;
      description?: unknown;
    }
  ) {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) throw new BadRequestException("Name is required");

    return this.workspaces.create(user.id, {
      name,
      description:
        typeof body.description === "string" && body.description.trim()
          ? body.description.trim()
          : null,
    });
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.workspaces.listForUser(user.id);
  }

  @Get(":id")
  detail(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.workspaces.detail(user.id, id);
  }

  @Get(":id/bootstrap")
  bootstrap(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.workspaces.bootstrap(user.id, id);
  }

  @Get(":id/settings/integrations")
  getIntegrations(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.workspaces.getIntegrations(user.id, id);
  }

  @Patch(":id/settings/integrations")
  updateIntegrations(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body()
    body: {
      anthropicApiKey?: string | null;
      githubToken?: string | null;
      slackBotToken?: string | null;
      slackAppToken?: string | null;
      allowDirectMerge?: boolean;
      debugMode?: boolean;
      defaultModel?: string;
      sandboxBypass?: boolean | null;
    }
  ) {
    this.assertNotDemo();
    return this.workspaces.updateIntegrations(user.id, id, body);
  }

  @Get(":id/settings/storage")
  getStorage(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.workspaces.getStorage(user.id, id);
  }

  @Patch(":id/settings/storage")
  updateStorage(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body()
    body: {
      mode?: "LOCAL" | "S3";
      localPath?: string | null;
      s3Bucket?: string | null;
      s3Region?: string | null;
      s3Prefix?: string | null;
      s3AccessKeyId?: string | null;
      s3SecretAccessKey?: string | null;
    }
  ) {
    this.assertNotDemo();
    return this.workspaces.updateStorage(user.id, id, body);
  }

  @Post(":id/settings/storage/test")
  @HttpCode(200)
  testStorage(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.workspaces.testStorage(user.id, id);
  }

  @Post(":id/settings/storage/migrate")
  @HttpCode(200)
  migrateStorage(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.assertNotDemo();
    return this.workspaces.migrateEnvsToConfiguredStorage(user.id, id);
  }

  @Get(":id/settings/secrets")
  listSecrets(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    return this.secrets.list(user.id, id);
  }

  @Post(":id/settings/secrets")
  @HttpCode(201)
  createSecret(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Body() body: { name?: unknown; value?: unknown }
  ) {
    this.assertNotDemo();
    return this.secrets.upsert(user.id, id, body);
  }

  @Put(":id/settings/secrets/:name")
  updateSecret(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("name") name: string,
    @Body() body: { value?: unknown }
  ) {
    this.assertNotDemo();
    return this.secrets.update(user.id, id, name, body);
  }

  @Delete(":id/settings/secrets/:name")
  deleteSecret(
    @CurrentUser() user: AuthUser,
    @Param("id") id: string,
    @Param("name") name: string
  ) {
    this.assertNotDemo();
    return this.secrets.delete(user.id, id, name);
  }
}
