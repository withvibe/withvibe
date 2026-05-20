import { ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { Request } from "express";
import { SESSION_COOKIE_NAME } from "./auth.service";

/**
 * Use on any controller/route that requires a valid bridge JWT.
 *
 * Wraps Passport's default JWT guard to log the *reason* an auth check
 * failed when a session cookie was actually present. Silent 401s drove a
 * pile of "why am I getting bounced to /login on refresh?" reports — most
 * commonly because INTERNAL_JWT_SECRET rotated between deploys, invalidating
 * every existing cookie. Logging the failure category at the boundary makes
 * those incidents diagnosable from prod logs.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(
    @InjectPinoLogger(JwtAuthGuard.name)
    private readonly logger: PinoLogger
  ) {
    super();
  }

  handleRequest<TUser = unknown>(
    err: Error | null,
    user: TUser | false,
    info: Error | { message?: string } | undefined,
    context: ExecutionContext
  ): TUser {
    if (!user) {
      const req = context.switchToHttp().getRequest<
        Request & { cookies?: Record<string, string> }
      >();
      const hadCookie = Boolean(req.cookies?.[SESSION_COOKIE_NAME]);
      const reason =
        (info && (info as { message?: string }).message) ||
        (err && err.message) ||
        "no token";
      // Down-leveled to debug for the common "no token, no cookie" case
      // (anonymous request) — only warn when a cookie was present, because
      // that's the case worth investigating.
      if (hadCookie) {
        this.logger.warn(
          `Auth failed despite session cookie present: reason="${reason}" url=${req.method} ${req.url}`
        );
      }
    }
    // Fall through to default Passport behavior (throws UnauthorizedException
    // when user is falsy).
    return super.handleRequest(err, user, info, context);
  }
}
