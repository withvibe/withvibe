import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  async create(
    userId: string,
    workspaceId: string,
    body: { email?: unknown; role?: unknown }
  ) {
    await this.access.admin(userId, workspaceId);
    const email =
      typeof body.email === "string" && body.email.trim()
        ? body.email.trim()
        : null;
    const role = body.role === "admin" ? "admin" : "member";

    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const invitation = await this.prisma.client.invitation.create({
      data: {
        workspaceId,
        email,
        token,
        role,
        invitedById: userId,
        expiresAt,
      },
    });
    return {
      id: invitation.id,
      token: invitation.token,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  }

  /** Public — no auth. Exposes minimal info so anyone with the link can preview. */
  async lookup(token: string) {
    const invitation = await this.prisma.client.invitation.findUnique({
      where: { token },
      include: {
        workspace: { select: { id: true, name: true, description: true } },
        invitedBy: { select: { name: true, email: true } },
      },
    });
    if (!invitation) throw new NotFoundException("Invitation not found");
    if (invitation.expiresAt && invitation.expiresAt < new Date()) {
      throw new GoneException("Invitation expired");
    }
    if (invitation.acceptedAt) {
      throw new GoneException("Invitation already used");
    }
    return {
      workspace: invitation.workspace,
      role: invitation.role,
      email: invitation.email,
      invitedBy: invitation.invitedBy,
    };
  }

  async accept(userId: string, token: string) {
    const invitation = await this.prisma.client.invitation.findUnique({
      where: { token },
    });
    if (!invitation) throw new NotFoundException("Invitation not found");
    if (invitation.expiresAt && invitation.expiresAt < new Date()) {
      throw new GoneException("Invitation expired");
    }
    if (invitation.acceptedAt) {
      throw new GoneException("Invitation already used");
    }

    const existing = await this.prisma.client.workspaceMember.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: invitation.workspaceId,
          userId,
        },
      },
    });
    if (existing) {
      throw new ConflictException({
        error: "Already a member",
        workspaceId: invitation.workspaceId,
      });
    }

    await this.prisma.client.$transaction([
      this.prisma.client.workspaceMember.create({
        data: {
          workspaceId: invitation.workspaceId,
          userId,
          role: invitation.role,
        },
      }),
      this.prisma.client.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      }),
    ]);
    return { workspaceId: invitation.workspaceId };
  }
}
