import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthUser } from "./auth/jwt.strategy";
import { PrismaService } from "./prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(@Res({ passthrough: true }) res: Response) {
    // Cheap, real probe — surfaces DB outages instead of the previous
    // unconditional "ok" that always lied. The frontend login page checks
    // this on a fetch timeout to distinguish "server still starting" from
    // "credentials wrong".
    if (!this.prisma.isReady()) {
      res.setHeader("Retry-After", "3");
      throw new HttpException(
        {
          status: "starting",
          service: "withvibe-api",
          ts: new Date().toISOString(),
        },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
    } catch (err) {
      res.setHeader("Retry-After", "3");
      throw new HttpException(
        {
          status: "db_unreachable",
          service: "withvibe-api",
          ts: new Date().toISOString(),
          detail: err instanceof Error ? err.message : String(err),
        },
        HttpStatus.SERVICE_UNAVAILABLE
      );
    }
    return {
      status: "ok",
      service: "withvibe-api",
      ts: new Date().toISOString(),
    };
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return { ok: true, user };
  }
}
