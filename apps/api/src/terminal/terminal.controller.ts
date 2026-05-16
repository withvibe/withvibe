import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * Mints a short-lived JWT for the Terminal WebSocket. Browsers can't set
 * custom headers on the WS handshake, so the client passes this token in the
 * URL as `?token=<jwt>` and `TerminalService` verifies it against
 * `INTERNAL_JWT_SECRET`. The client also needs `apiBaseUrl` to know which
 * host to open the WS against (the API runs on a separate origin from Next).
 */
@Controller("terminal")
@UseGuards(JwtAuthGuard)
export class TerminalController {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService
  ) {}

  @Post("ws-token")
  @HttpCode(HttpStatus.OK)
  issue(@CurrentUser() user: AuthUser) {
    const token = this.jwt.sign(
      { userId: user.id, email: user.email },
      { expiresIn: "60s" }
    );
    // API_PUBLIC_URL is what the installer actually sets on a domain deploy
    // (= https://<domain>); without it this fell through to localhost:4000
    // and the browser opened the WS against its own machine. The new
    // Traefik path-prefix router forwards /api/terminal/ to api:4000, so the
    // public domain is now a valid WS origin.
    const apiBaseUrl =
      this.config.get<string>("PUBLIC_API_BASE_URL") ||
      this.config.get<string>("API_BASE_URL") ||
      this.config.get<string>("API_PUBLIC_URL") ||
      "http://localhost:4000";
    return { token, apiBaseUrl };
  }
}
