import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, type Profile, type VerifyCallback } from "passport-google-oauth20";

export type GoogleUser = {
  email: string;
  name: string | null;
};

/**
 * Google OAuth — replaces NextAuth's GoogleProvider. The callback URL
 * registered in Google Cloud Console must be:
 *   `${API_PUBLIC_URL}/api/auth/google/callback`
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
  private static readonly logger = new Logger("GoogleStrategy");

  constructor(config: ConfigService) {
    const clientID = config.get<string>("GOOGLE_CLIENT_ID");
    const clientSecret = config.get<string>("GOOGLE_CLIENT_SECRET");
    const apiBase = config.get<string>("API_PUBLIC_URL") || "http://localhost:4000";

    if (!clientID || !clientSecret) {
      // Don't throw — this lets the API boot in dev environments without
      // Google configured. The /auth/google route will 503 instead.
      GoogleStrategy.logger.warn(
        "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google login disabled"
      );
    }

    super({
      clientID: clientID || "missing",
      clientSecret: clientSecret || "missing",
      callbackURL: `${apiBase.replace(/\/$/, "")}/api/auth/google/callback`,
      scope: ["email", "profile"],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback
  ): void {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      done(new Error("Google profile missing email"), undefined);
      return;
    }
    const user: GoogleUser = {
      email,
      name: profile.displayName || null,
    };
    done(null, user);
  }
}
