import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  async list(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);
    const members = await this.prisma.client.workspaceMember.findMany({
      where: { workspaceId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            positions: true,
            bio: true,
          },
        },
      },
      orderBy: { joinedAt: "asc" },
    });
    return members.map((m) => ({
      id: m.id,
      role: m.role,
      joinedAt: m.joinedAt,
      user: m.user,
      isMe: m.userId === userId,
    }));
  }
}
