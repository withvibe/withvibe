import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { parseUserProfileInput } from "../common/profile-input";
import {
  verifyAnthropicKey,
  AnthropicKeyError,
} from "../common/anthropic-key";

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
        githubToken: true,
        githubLogin: true,
      },
    });
    if (!user) throw new NotFoundException("User not found");
    const adminMemberships = await this.prisma.client.workspaceMember.count({
      where: { userId, role: "admin" },
    });
    // Never return the raw personal key — only whether it's set and a masked
    // hint (last 4 chars) so the UI can show "sk-…abcd" without exposing it.
    const { anthropicApiKey, githubToken, ...safe } = user;
    return {
      ...safe,
      isDeploymentAdmin: adminMemberships > 0,
      anthropicKeySet: Boolean(anthropicApiKey),
      anthropicKeyHint: anthropicApiKey
        ? `…${anthropicApiKey.slice(-4)}`
        : null,
      githubTokenSet: Boolean(githubToken),
      githubTokenHint: githubToken ? `…${githubToken.slice(-4)}` : null,
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
      githubToken?: unknown;
    }
  ) {
    const data: {
      name?: string | null;
      positions?: string[];
      bio?: string | null;
      defaultWorkspaceId?: string | null;
      anthropicApiKey?: string | null;
      githubToken?: string | null;
      githubLogin?: string | null;
      githubUserId?: number | null;
    } = {};

    if (typeof body.name === "string") {
      const trimmed = body.name.trim();
      data.name = trimmed || null;
    }

    // Personal Anthropic key: a non-empty string sets it, an empty string or
    // null clears it. Checked with Anthropic before storing — a key that will
    // not work is worth saying so about here, rather than as "AI request
    // failed" in a chat two steps later, which names neither the key nor which
    // of the three it was.
    if (body.anthropicApiKey !== undefined) {
      if (body.anthropicApiKey === null) {
        data.anthropicApiKey = null;
      } else if (typeof body.anthropicApiKey === "string") {
        const trimmed = body.anthropicApiKey.trim();
        if (!trimmed) {
          data.anthropicApiKey = null;
        } else {
          try {
            await verifyAnthropicKey(trimmed);
          } catch (err) {
            throw new BadRequestException(
              err instanceof AnthropicKeyError ? err.message : String(err)
            );
          }
          data.anthropicApiKey = trimmed;
        }
      }
    }

    // Personal GitHub token. Unlike the Anthropic key this IS validated here,
    // by asking GitHub who it belongs to: a token that does not work is worth
    // saying so about immediately rather than at the next push, and the answer
    // carries the login and numeric id that make a commit appear as this
    // person's on GitHub rather than only in `git log`.
    if (body.githubToken !== undefined) {
      if (body.githubToken === null || body.githubToken === "") {
        data.githubToken = null;
        data.githubLogin = null;
        data.githubUserId = null;
      } else if (typeof body.githubToken === "string") {
        const trimmed = body.githubToken.trim();
        if (!trimmed) {
          data.githubToken = null;
          data.githubLogin = null;
          data.githubUserId = null;
        } else {
          const identity = await this.resolveGithubIdentity(trimmed);
          data.githubToken = trimmed;
          data.githubLogin = identity.login;
          data.githubUserId = identity.id;
        }
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
        githubToken: true,
        githubLogin: true,
      },
    });
    const { anthropicApiKey, githubToken, ...safe } = updated;
    return {
      ...safe,
      anthropicKeySet: Boolean(anthropicApiKey),
      anthropicKeyHint: anthropicApiKey ? `…${anthropicApiKey.slice(-4)}` : null,
      githubTokenSet: Boolean(githubToken),
      githubTokenHint: githubToken ? `…${githubToken.slice(-4)}` : null,
    };
  }

  /** Ask GitHub who a token belongs to. Throws with GitHub's own reason. */
  private async resolveGithubIdentity(
    token: string
  ): Promise<{ login: string; id: number }> {
    let res: Response;
    try {
      res = await fetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "withvibe",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new BadRequestException(
        `Could not reach GitHub to check the token: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (res.status === 401) {
      throw new BadRequestException(
        "GitHub rejected that token. Check it was copied in full and has not expired."
      );
    }
    if (!res.ok) {
      throw new BadRequestException(
        `GitHub returned ${res.status} when checking the token.`
      );
    }
    const body = (await res.json()) as { login?: unknown; id?: unknown };
    if (typeof body.login !== "string" || typeof body.id !== "number") {
      throw new BadRequestException(
        "GitHub did not return an account for that token."
      );
    }
    return { login: body.login, id: body.id };
  }
}
