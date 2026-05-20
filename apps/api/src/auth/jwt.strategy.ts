import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy, type JwtFromRequestFunction } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
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
  constructor(
    config: ConfigService,
    @InjectPinoLogger(JwtStrategy.name)
    private readonly logger: PinoLogger
  ) {
    const secret = config.get<string>("INTERNAL_JWT_SECRET");
    if (!secret) {
      throw new Error(
        "INTERNAL_JWT_SECRET is not set — configure it in apps/api/.env"
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        // Wrap the extractors so we can log the "had a cookie but it was
        // bogus" case — that's the single most useful signal when a user
        // reports "I got bounced to /login on refresh" and we can't tell
        // whether the cookie was missing, expired, or signed with a stale
        // INTERNAL_JWT_SECRET (a common foot-gun after .env regeneration).
        (req: Request) => {
          const token = fromCookie(req);
          if (token) {
            (req as Request & { _hadSessionCookie?: boolean })._hadSessionCookie =
              true;
          }
          return token;
        },
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
      passReqToCallback: true,
    });
  }

  async validate(
    req: Request,
    payload: BridgeJwtPayload
  ): Promise<AuthUser> {
    if (!payload?.userId || !payload?.email) {
      const hadCookie = (req as Request & { _hadSessionCookie?: boolean })
        ._hadSessionCookie;
      this.logger.warn(
        `Rejected JWT with malformed payload (hadCookie=${hadCookie ? "yes" : "no"} url=${req.url})`
      );
      throw new UnauthorizedException("Malformed token");
    }
    return { id: payload.userId, email: payload.email };
  }
}
