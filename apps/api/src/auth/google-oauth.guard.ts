import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { AuthGuard, type IAuthModuleOptions } from "@nestjs/passport";
import { randomBytes, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { AuthService, OAUTH_STATE_COOKIE } from "./auth.service";

type RequestWithState = Request & { _oauthState?: string };

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Google OAuth guard with CSRF protection (login-CSRF / authorization-response
 * replay). `passport-google-oauth20` does NOT enable the OAuth `state`
 * parameter unless a session-backed state store is configured, and this app is
 * stateless (JWT cookies, no express-session). So we bind `state` to the
 * initiating browser manually:
 *
 *   - On the start request we mint a random nonce, drop it in a short-lived
 *     httpOnly cookie, and hand it to passport as the `state` option — passport
 *     forwards it to Google, which echoes it back on the callback.
 *   - On the callback we require the `state` query param to match the cookie
 *     before passport runs. A missing/mismatched state — a flow the victim's
 *     browser never initiated — is rejected, so an attacker can't complete a
 *     Google sign-in into someone else's session.
 */
@Injectable()
export class GoogleOAuthGuard extends AuthGuard("google") {
  constructor(private readonly auth: AuthService) {
    super();
  }

  getAuthenticateOptions(context: ExecutionContext): IAuthModuleOptions {
    const req = context.switchToHttp().getRequest<RequestWithState>();
    return req._oauthState ? { state: req._oauthState } : {};
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithState>();
    const res = context.switchToHttp().getResponse<Response>();
    // The callback carries Google's response (code/state, or error); the start
    // request carries none of those.
    const isCallback =
      typeof req.query.code === "string" ||
      typeof req.query.state === "string" ||
      typeof req.query.error === "string";

    if (isCallback) {
      const expected = req.cookies?.[OAUTH_STATE_COOKIE];
      const actual = typeof req.query.state === "string" ? req.query.state : "";
      // Single-use: clear the nonce regardless of outcome.
      this.auth.clearOAuthStateCookie(res);
      if (!expected || !actual || !safeEqual(expected, actual)) {
        throw new UnauthorizedException("Invalid OAuth state");
      }
    } else {
      const state = randomBytes(32).toString("hex");
      this.auth.setOAuthStateCookie(res, state);
      req._oauthState = state;
    }

    return (await super.canActivate(context)) as boolean;
  }
}
