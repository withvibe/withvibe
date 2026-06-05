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
        anthropicApiKey: true,
      },
    });
    if (!user) throw new NotFoundException("User not found");
    const adminMemberships = await this.prisma.client.workspaceMember.count({
      where: { userId, role: "admin" },
    });
    // Never return the raw personal key — only whether it's set and a masked
    // hint (last 4 chars) so the UI can show "sk-…abcd" without exposing it.
    const { anthropicApiKey, ...safe } = user;
    return {
      ...safe,
      isDeploymentAdmin: adminMemberships > 0,
      anthropicKeySet: Boolean(anthropicApiKey),
      anthropicKeyHint: anthropicApiKey
        ? `…${anthropicApiKey.slice(-4)}`
        : null,
    };
  }

  async update(
    userId: string,
    body: {
      name?: unknown;
      positions?: unknown;
      bio?: unknown;
      defaultWorkspaceId?: unknown;
      anthropicApiKey?: unknown;
    }
  ) {
    const data: {
      name?: string | null;
      positions?: string[];
      bio?: string | null;
      defaultWorkspaceId?: string | null;
      anthropicApiKey?: string | null;
    } = {};

    if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      data.name = trimmed || null;
    }

    // Personal Anthropic key: a non-empty string sets it, an empty string or
    // null clears it. We don't validate the format here — Anthropic rejects a
    // bad key at request time and the chat surfaces that error.
    if (body.anthropicApiKey !== undefined) {
      if (body.anthropicApiKey === null) {
        data.anthropicApiKey = null;
      } else if (typeof body.anthropicApiKey === "string") {
        const trimmed = body.anthropicApiKey.trim();
        data.anthropicApiKey = trimmed || null;
      }
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

    const updated = await this.prisma.client.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        positions: true,
        bio: true,
        defaultWorkspaceId: true,
        anthropicApiKey: true,
      },
    });
    const { anthropicApiKey, ...safe } = updated;
    return {
      ...safe,
      anthropicKeySet: Boolean(anthropicApiKey),
      anthropicKeyHint: anthropicApiKey ? `…${anthropicApiKey.slice(-4)}` : null,
    };
  }
}
