import { Controller, Get, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { CurrentUser } from "./auth/current-user.decorator";
import type { AuthUser } from "./auth/jwt.strategy";

@Controller("health")
export class HealthController {
  @Get()
  check() {
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
