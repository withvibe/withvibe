import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable, tap } from "rxjs";
import { AuthService, SESSION_COOKIE_NAME } from "./auth.service";
import type { AuthUser, BridgeJwtPayload } from "./jwt.strategy";
import { JwtService } from "@nestjs/jwt";

const ROTATE_AFTER_SECONDS = 30 * 60;

/**
 * Sliding-session: when a request authenticates via the cookie and the JWT
 * was issued more than ROTATE_AFTER_SECONDS ago, mint a fresh token and
 * re-set the cookie so an active user's session keeps extending. Idle users
 * still hit the absolute 8h TTL.
 */
@Injectable()
export class SessionRotationInterceptor implements NestInterceptor {
  constructor(
    private readonly auth: AuthService,
    private readonly jwt: JwtService
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<
      Request & {
        cookies?: Record<string, string>;
        user?: AuthUser;
      }
    >();
    const res = http.getResponse<Response>();

    return next.handle().pipe(
      tap(() => {
        const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
        if (!cookieToken || !req.user) return;

        const payload = this.jwt.decode(cookieToken) as BridgeJwtPayload | null;
        if (!payload?.iat) return;

        const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
        if (ageSeconds < ROTATE_AFTER_SECONDS) return;

        const fresh = this.auth.signSessionToken({
          id: req.user.id,
          email: req.user.email,
        });
        this.auth.setSessionCookie(res, fresh);
      })
    );
  }
}
