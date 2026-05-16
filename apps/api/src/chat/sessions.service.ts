import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  private async assertEnv(
    userId: string,
    workspaceId: string,
    envId: string
  ) {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
  }

  async list(userId: string, workspaceId: string, envId: string) {
    await this.assertEnv(userId, workspaceId, envId);
    const sessions = await this.prisma.client.chatSession.findMany({
      where: { envId, userId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { messages: true } },
        agent: { select: { id: true, slug: true, name: true } },
      },
    });
    const legacyCount = await this.prisma.client.message.count({
      where: { envId, userId, sessionId: null },
    });
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        messageCount: s._count.messages,
        agent: s.agent,
      })),
      legacyCount,
    };
  }

  async create(
    userId: string,
    workspaceId: string,
    envId: string,
    body: { title?: unknown; agentId?: unknown }
  ) {
    await this.assertEnv(userId, workspaceId, envId);
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim()
        : null;
    const agentId =
      typeof body.agentId === "string" && body.agentId.trim()
        ? body.agentId.trim()
        : null;

    if (agentId) {
      const agent = await this.prisma.client.agent.findUnique({
        where: { id: agentId },
      });
      if (!agent || agent.workspaceId !== workspaceId) {
        throw new BadRequestException("Invalid agentId");
      }
    }

    const session = await this.prisma.client.chatSession.create({
      data: { envId, userId, title, agentId },
      include: { agent: { select: { id: true, slug: true, name: true } } },
    });
    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      messageCount: 0,
      agent: session.agent,
    };
  }

  async rename(
    userId: string,
    workspaceId: string,
    envId: string,
    sessionId: string,
    body: { title?: unknown }
  ) {
    await this.assertEnv(userId, workspaceId, envId);
    const session = await this.prisma.client.chatSession.findUnique({
      where: { id: sessionId },
    });
    if (
      !session ||
      session.envId !== envId ||
      session.userId !== userId
    ) {
      throw new NotFoundException("Session not found");
    }
    const data: { title?: string | null } = {};
    if (typeof body.title === "string") {
      const t = body.title.trim();
      data.title = t || null;
    }
    const updated = await this.prisma.client.chatSession.update({
      where: { id: sessionId },
      data,
    });
    return {
      id: updated.id,
      title: updated.title,
      createdAt: updated.createdAt,
    };
  }

  async delete(
    userId: string,
    workspaceId: string,
    envId: string,
    sessionId: string
  ) {
    await this.assertEnv(userId, workspaceId, envId);
    const session = await this.prisma.client.chatSession.findUnique({
      where: { id: sessionId },
    });
    if (
      !session ||
      session.envId !== envId ||
      session.userId !== userId
    ) {
      throw new NotFoundException("Session not found");
    }
    await this.prisma.client.$transaction([
      this.prisma.client.message.deleteMany({ where: { sessionId } }),
      this.prisma.client.chatSession.delete({ where: { id: sessionId } }),
    ]);
    return { ok: true };
  }

  async validateForPost(
    userId: string,
    workspaceId: string,
    envId: string,
    sessionId: string
  ): Promise<{ taskId: string; userId: string; title: string | null } | null> {
    await this.assertEnv(userId, workspaceId, envId);
    const owned = await this.prisma.client.chatSession.findUnique({
      where: { id: sessionId },
      select: { envId: true, userId: true, title: true },
    });
    if (!owned || owned.envId !== envId || owned.userId !== userId) return null;
    return { taskId: owned.envId, userId: owned.userId, title: owned.title };
  }

  // Internal helper used by messages flow — checks session ownership or throws.
  async assertSessionOwned(
    userId: string,
    workspaceId: string,
    envId: string,
    sessionId: string
  ) {
    await this.assertEnv(userId, workspaceId, envId);
    const owned = await this.prisma.client.chatSession.findUnique({
      where: { id: sessionId },
      select: { envId: true, userId: true, title: true },
    });
    if (!owned || owned.envId !== envId || owned.userId !== userId) {
      throw new ForbiddenException("Invalid session");
    }
    return owned;
  }
}
