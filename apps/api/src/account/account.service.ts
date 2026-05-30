import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { parseUserProfileInput } from "../common/profile-input";

@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async me(userId: string) {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        positions: true,
        bio: true,
        createdAt: true,
        defaultWorkspaceId: true,
      },
    });
    if (!user) throw new NotFoundException("User not found");
    const adminMemberships = await this.prisma.client.workspaceMember.count({
      where: { userId, role: "admin" },
    });
    return { ...user, isDeploymentAdmin: adminMemberships > 0 };
  }

  async update(
    userId: string,
    body: {
      name?: unknown;
      positions?: unknown;
      bio?: unknown;
      defaultWorkspaceId?: unknown;
    }
  ) {
    const data: {
      name?: string | null;
      positions?: string[];
      bio?: string | null;
      defaultWorkspaceId?: string | null;
    } = {};

    if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      data.name = trimmed || null;
    }

    Object.assign(data, parseUserProfileInput(body));

    if (body.defaultWorkspaceId !== undefined) {
      if (body.defaultWorkspaceId === null) {
        data.defaultWorkspaceId = null;
      } else if (typeof body.defaultWorkspaceId === "string") {
        const member = await this.prisma.client.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: body.defaultWorkspaceId,
              userId,
            },
          },
        });
        if (!member) {
          throw new ForbiddenException("Not a member of that workspace");
        }
        data.defaultWorkspaceId = body.defaultWorkspaceId;
      }
    }

    return this.prisma.client.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        positions: true,
        bio: true,
        defaultWorkspaceId: true,
      },
    });
  }
}
