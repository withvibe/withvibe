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
  UseGuards,
} from "@nestjs/common";
import { z, ZodError } from "zod";
import { AdminGuard } from "../auth/admin.guard";
import { CliOrJwtAuthGuard } from "../auth/cli-or-jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { PluginsService } from "./plugins.service";

const InstallBody = z.object({
  manifestText: z.string().min(1),
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

@Controller("admin/plugins")
@UseGuards(CliOrJwtAuthGuard, AdminGuard)
export class PluginsAdminController {
  constructor(private readonly plugins: PluginsService) {}

  @Get()
  async list() {
    const plugins = await this.plugins.listAll();
    return { plugins };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async install(@Body() body: unknown, @CurrentUser() user: AuthUser) {
    const { manifestText } = parseBody(InstallBody, body);
    return this.plugins.install(manifestText, user.id);
  }

  @Patch(":pluginId")
  async toggle(
    @Param("pluginId") pluginId: string,
    @Body() body: unknown
  ) {
    const { enabled, defaultEnabledInEnv } = parseBody(PatchBody, body);
    return this.plugins.updateAdminFlags(pluginId, {
      enabled,
      defaultEnabledInEnv,
    });
  }

  @Delete(":pluginId")
  @HttpCode(HttpStatus.OK)
  async uninstall(@Param("pluginId") pluginId: string) {
    return this.plugins.uninstall(pluginId);
  }
}
