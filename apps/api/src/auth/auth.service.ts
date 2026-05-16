import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import bcrypt from "bcryptjs";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { parseUserProfileInput } from "../common/profile-input";
import type { LoginInput, RegisterInput } from "./dto/auth.dto";

const BCRYPT_ROUNDS = 12;
const SESSION_COOKIE = "withvibe_session";
// 8 hours — matches the previous NextAuth `maxAge` so user-visible behavior
// doesn't change across the migration.
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type SessionUser = { id: string; email: string };

@Injectable()
export class AuthService {
  private readonly cookieDomain: string | undefined;
  private readonly cookieSecure: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    config: ConfigService
  ) {
    this.cookieDomain = config.get<string>("COOKIE_DOMAIN") || undefined;
    // Auto-on in production, off in dev (HTTP localhost). Override via env.
    const explicit = config.get<string>("COOKIE_SECURE");
    this.cookieSecure =
      explicit === "true" ||
      (explicit !== "false" && process.env.NODE_ENV === "production");
  }

  async register(input: RegisterInput): Promise<SessionUser> {
    const existing = await this.prisma.client.user.findUnique({
      where: { email: input.email },
    });
    if (existing) {
      throw new ConflictException("Email already registered");
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const profile = parseUserProfileInput({
      positions: input.positions,
      bio: input.bio,
    });

    const user = await this.prisma.client.user.create({
      data: {
        email: input.email,
        name: input.name ?? null,
        passwordHash,
        ...profile,
      },
      select: { id: true, email: true },
    });

    return user;
  }

  async login(input: LoginInput): Promise<SessionUser> {
    const user = await this.prisma.client.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true, passwordHash: true },
    });

    // Same error on missing user vs wrong password — don't leak account
    // existence via timing or response shape.
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException("Invalid credentials");
    }

    return { id: user.id, email: user.email };
  }

  /**
   * Find or create a user from a verified Google OAuth profile. No password
   * is set — the user can later set one by going through "forgot password"
   * (when that exists) or by re-registering with the same email.
   */
  async findOrCreateGoogleUser(
    email: string,
    name: string | null
  ): Promise<SessionUser> {
    const normalized = email.trim().toLowerCase();
    const existing = await this.prisma.client.user.findUnique({
      where: { email: normalized },
      select: { id: true, email: true },
    });
    if (existing) return existing;

    const created = await this.prisma.client.user.create({
      data: { email: normalized, name },
      select: { id: true, email: true },
    });
    return created;
  }

  signSessionToken(user: SessionUser): string {
    return this.jwt.sign(
      { userId: user.id, email: user.email },
      { expiresIn: `${SESSION_TTL_SECONDS}s` }
    );
  }

  setSessionCookie(res: Response, token: string): void {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: "lax",
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: "/",
      domain: this.cookieDomain,
    });
  }

  clearSessionCookie(res: Response): void {
    res.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      secure: this.cookieSecure,
      sameSite: "lax",
      path: "/",
      domain: this.cookieDomain,
    });
  }
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
