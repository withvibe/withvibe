import crypto from "crypto";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy } from "passport-custom";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthUser } from "./jwt.strategy";

const TOKEN_PREFIX = "wv_cli_";

@Injectable()
export class CliTokenStrategy extends PassportStrategy(Strategy, "cli-token") {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async validate(req: Request): Promise<AuthUser> {
    const header = req.headers.authorization;
    const m = header?.match(/^Bearer\s+(.+)$/i);
    const secret = m?.[1]?.trim();
    if (!secret || !secret.startsWith(TOKEN_PREFIX)) {
      throw new UnauthorizedException("CLI token required");
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(secret)
      .digest("hex");

    const row = await this.prisma.client.cliToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!row || row.revokedAt) {
      throw new UnauthorizedException("Invalid or revoked CLI token");
    }

    // Best-effort: bump lastUsedAt without blocking the request.
    this.prisma.client.cliToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return { id: row.user.id, email: row.user.email };
  }
}
