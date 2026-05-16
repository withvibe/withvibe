import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy, type JwtFromRequestFunction } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import { SESSION_COOKIE_NAME } from "./auth.service";

/**
 * Validates the session JWT — accepted from either:
 *   1. The `withvibe_session` HTTP-only cookie set by AuthService at login.
 *   2. `Authorization: Bearer <token>` (used by the legacy web→api bridge
 *      and the `withvibe` CLI's bearer tokens).
 *
 * Token shape (HS256): `{ userId: string, email: string, iat, exp }`
 * Signed with `INTERNAL_JWT_SECRET`.
 */

export type BridgeJwtPayload = {
  userId: string;
  email: string;
  iat: number;
  exp: number;
};

export type AuthUser = {
  id: string;
  email: string;
};

const fromCookie: JwtFromRequestFunction = (req: Request) => {
  const cookies = (req as Request & { cookies?: Record<string, string> })
    .cookies;
  return cookies?.[SESSION_COOKIE_NAME] ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(config: ConfigService) {
    const secret = config.get<string>("INTERNAL_JWT_SECRET");
    if (!secret) {
      throw new Error(
        "INTERNAL_JWT_SECRET is not set — configure it in apps/api/.env"
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        fromCookie,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  async validate(payload: BridgeJwtPayload): Promise<AuthUser> {
    if (!payload?.userId || !payload?.email) {
      throw new UnauthorizedException("Malformed token");
    }
    return { id: payload.userId, email: payload.email };
  }
}
