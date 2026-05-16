import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Shared helper for endpoints that need to confirm the caller belongs to
 * a workspace (member) or owns it (admin). Kept out of a guard so services
 * can call it directly when a controller handles multiple workspaces
 * or needs the member record for further logic.
 */
@Injectable()
export class WorkspaceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Ensure the user is a member of the workspace. Returns the member row. */
  async member(userId: string, workspaceId: string) {
    const member = await this.prisma.client.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) {
      throw new ForbiddenException("Not a workspace member");
    }
    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { deletedAt: true },
    });
    if (!workspace || workspace.deletedAt) {
      throw new NotFoundException("Workspace not found");
    }
    return member;
  }

  /** Ensure the user is an admin of the workspace. Returns the member row. */
  async admin(userId: string, workspaceId: string) {
    const member = await this.member(userId, workspaceId);
    if (member.role !== "admin") {
      throw new ForbiddenException("Admin access required");
    }
    return member;
  }
}
