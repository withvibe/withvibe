import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthUser } from "./jwt.strategy";

/**
 * Gate for deployment-wide admin actions (plugin install/uninstall, etc.).
 * Deployment admin is derived: a user is a deployment admin iff they are
 * admin in at least one workspace. The check runs per request (not from the
 * JWT) so role changes take effect immediately instead of waiting for the
 * 8h session to expire.
 *
 * Usage:
 *   @UseGuards(CliOrJwtAuthGuard, AdminGuard)
 *   @Controller("admin/...")
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { user?: AuthUser }>();
    if (!req.user?.id) {
      throw new ForbiddenException("Not authenticated");
    }
    const adminMembership = await this.prisma.client.workspaceMember.count({
      where: { userId: req.user.id, role: "admin" },
    });
    if (adminMembership === 0) {
      throw new ForbiddenException("Admin only");
    }
    return true;
  }
}
