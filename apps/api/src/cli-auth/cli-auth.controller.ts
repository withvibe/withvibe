import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthUser } from "../auth/jwt.strategy";
import { CliAuthService } from "./cli-auth.service";

@Controller("cli-auth")
export class CliAuthController {
  constructor(private readonly cliAuth: CliAuthService) {}

  @Post("initiate")
  @HttpCode(HttpStatus.OK)
  async initiate(@Body() body: { label?: unknown } | undefined) {
    const rawLabel =
      typeof body?.label === "string" ? body.label.trim() : "";
    const label = rawLabel.length > 0 ? rawLabel.slice(0, 200) : null;
    return this.cliAuth.initiate(label);
  }

  @Get("code/:code")
  describe(@Param("code") code: string) {
    if (!code) throw new BadRequestException("code required");
    return this.cliAuth.describe(code.trim());
  }

  @Get("poll")
  poll(@Query("code") code: string | undefined) {
    if (!code) throw new BadRequestException("code required");
    return this.cliAuth.poll(code.trim());
  }

  @Post("confirm")
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async confirm(
    @CurrentUser() user: AuthUser,
    @Body() body: { code?: unknown } | undefined
  ) {
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code) throw new BadRequestException("code required");
    await this.cliAuth.confirm(code, user.id);
    return { ok: true };
  }
}
