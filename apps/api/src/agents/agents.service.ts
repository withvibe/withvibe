import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@withvibe/db";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { AgentGreetingService } from "./agent-greeting.service";
import { CloneSeedService } from "./clone-seed.service";

export const TOOL_TOGGLE_KEYS = [
  "bash",
  "read",
  "edit",
  "write",
  "webFetch",
  "webSearch",
  "grep",
  "glob",
] as const;

export type ToolToggleKey = (typeof TOOL_TOGGLE_KEYS)[number];

export type ToolToggles = Partial<Record<ToolToggleKey, boolean>>;

export type CreateAgentInput = {
  name: string;
  description: string;
  systemPrompt: string;
  greetingTemplate?: string;
  toolToggles?: ToolToggles | null;
};

export type UpdateAgentInput = {
  name?: string;
  description?: string;
  systemPrompt?: string;
  greetingTemplate?: string;
  toolToggles?: ToolToggles | null;
  pinned?: boolean;
  position?: number;
};

function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "agent"
  );
}

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly greetings: AgentGreetingService,
    private readonly cloneSeed: CloneSeedService
  ) {}

  async listForEnv(userId: string, workspaceId: string, envId: string) {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }

    this.logger.debug(`Listing agents for workspace=${workspaceId} env=${envId}`);

    const agents = await this.prisma.client.agent.findMany({
      where: { workspaceId },
      orderBy: [
        { pinned: "desc" },
        { position: "asc" },
        { createdAt: "asc" },
      ],
      include: {
        _count: {
          select: {
            skills: {
              where: {
                OR: [{ scope: "workspace" }, { scope: "env", envId }],
              },
            },
            files: {
              where: {
                OR: [{ scope: "workspace" }, { scope: "env", envId }],
              },
            },
          },
        },
      },
    });

    const disabledRows = await this.prisma.client.envAgentDisabled.findMany({
      where: { envId },
      select: { agentId: true },
    });
    const disabledSet = new Set(disabledRows.map((r) => r.agentId));

    return agents.map((a) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      description: a.description,
      builtIn: a.builtIn,
      pinned: a.pinned,
      skillCount: a._count.skills,
      fileCount: a._count.files,
      disabledInEnv: disabledSet.has(a.id),
    }));
  }

  async listForWorkspace(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);
    const agents = await this.prisma.client.agent.findMany({
      where: { workspaceId },
      orderBy: [
        { pinned: "desc" },
        { position: "asc" },
        { createdAt: "asc" },
      ],
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        builtIn: true,
        pinned: true,
        position: true,
        toolToggles: true,
        kind: true,
        cloneForUserId: true,
        cloneForUser: { select: { id: true, name: true, email: true } },
        createdAt: true,
        updatedAt: true,
      },
    });
    return agents.map((a) => ({
      ...a,
      canEdit: this.canEditAgent(a, userId),
    }));
  }

  private canEditAgent(
    a: { builtIn: boolean; kind: string; cloneForUserId: string | null },
    userId: string
  ): boolean {
    if (a.builtIn) return false;
    if (a.kind === "member_clone") return a.cloneForUserId === userId;
    return true;
  }

  async detail(
    userId: string,
    workspaceId: string,
    agentId: string,
    envId: string | null
  ) {
    await this.access.member(userId, workspaceId);
    const agent = await this.prisma.client.agent.findUnique({
      where: { id: agentId },
    });
    if (!agent || agent.workspaceId !== workspaceId) {
      throw new NotFoundException("Agent not found");
    }

    this.logger.debug(
      `Agent detail: id=${agentId} slug=${agent.slug} workspace=${workspaceId} env=${envId ?? "none"}`
    );

    const skillWhere = envId
      ? {
          agentId,
          OR: [{ scope: "workspace" }, { scope: "env", envId }],
        }
      : { agentId, scope: "workspace" };

    const skills = await this.prisma.client.agentSkill.findMany({
      where: skillWhere,
      orderBy: [{ scope: "desc" }, { createdAt: "asc" }],
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        content: true,
        scope: true,
        envId: true,
        source: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const owner = agent.cloneForUserId
      ? await this.prisma.client.user.findUnique({
          where: { id: agent.cloneForUserId },
          select: { id: true, name: true, email: true },
        })
      : null;

    return {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      greetingTemplate: agent.greetingTemplate,
      toolToggles: agent.toolToggles,
      builtIn: agent.builtIn,
      pinned: agent.pinned,
      kind: agent.kind,
      cloneForUser: owner,
      canEdit: this.canEditAgent(agent, userId),
      skills,
    };
  }

  async create(userId: string, workspaceId: string, input: CreateAgentInput) {
    await this.access.member(userId, workspaceId);

    const name = input.name.trim();
    if (name.length < 2) {
      throw new BadRequestException("Name must be at least 2 characters");
    }
    if (input.description.trim().length < 2) {
      throw new BadRequestException("Description is required");
    }
    if (input.systemPrompt.trim().length < 10) {
      throw new BadRequestException("System prompt must be at least 10 characters");
    }

    const slug = await this.uniqueSlug(workspaceId, name);
    const greetingTemplate =
      input.greetingTemplate?.trim() ||
      (await this.greetings.generate({
        workspaceId,
        name,
        description: input.description,
        systemPrompt: input.systemPrompt,
      }));

    const toggles = sanitizeToolToggles(input.toolToggles);
    const agent = await this.prisma.client.agent.create({
      data: {
        workspaceId,
        slug,
        name,
        description: input.description.trim(),
        systemPrompt: input.systemPrompt,
        greetingTemplate,
        toolToggles: toggles === null ? Prisma.DbNull : toggles,
        builtIn: false,
      },
    });

    this.logger.log(
      `Agent created: id=${agent.id} slug=${slug} workspace=${workspaceId} by user=${userId}`
    );
    return { id: agent.id, slug: agent.slug };
  }

  async update(
    userId: string,
    workspaceId: string,
    agentId: string,
    input: UpdateAgentInput
  ) {
    await this.access.member(userId, workspaceId);
    const existing = await this.prisma.client.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        workspaceId: true,
        builtIn: true,
        kind: true,
        cloneForUserId: true,
      },
    });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new NotFoundException("Agent not found");
    }
    if (existing.builtIn) {
      throw new BadRequestException("Built-in agents cannot be edited");
    }
    if (
      existing.kind === "member_clone" &&
      existing.cloneForUserId !== userId
    ) {
      throw new BadRequestException(
        "Only the clone's owner can edit this agent"
      );
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const n = input.name.trim();
      if (n.length < 2) throw new BadRequestException("Name too short");
      data.name = n;
    }
    if (input.description !== undefined) {
      const d = input.description.trim();
      if (d.length < 2) throw new BadRequestException("Description too short");
      data.description = d;
    }
    if (input.systemPrompt !== undefined) {
      if (input.systemPrompt.trim().length < 10) {
        throw new BadRequestException("System prompt too short");
      }
      data.systemPrompt = input.systemPrompt;
    }
    if (input.greetingTemplate !== undefined) {
      data.greetingTemplate = input.greetingTemplate;
    }
    if (input.toolToggles !== undefined) {
      const toggles = sanitizeToolToggles(input.toolToggles);
      data.toolToggles = toggles === null ? Prisma.DbNull : toggles;
    }
    if (input.pinned !== undefined) data.pinned = input.pinned;
    if (input.position !== undefined) data.position = input.position;

    await this.prisma.client.agent.update({
      where: { id: agentId },
      data,
    });
    this.logger.log(
      `Agent updated: id=${agentId} workspace=${workspaceId} by user=${userId} fields=${Object.keys(data).join(",")}`
    );
    return { ok: true };
  }

  async remove(userId: string, workspaceId: string, agentId: string) {
    await this.access.member(userId, workspaceId);
    const existing = await this.prisma.client.agent.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        workspaceId: true,
        builtIn: true,
        kind: true,
        cloneForUserId: true,
      },
    });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new NotFoundException("Agent not found");
    }
    if (existing.builtIn) {
      throw new BadRequestException("Built-in agents cannot be deleted");
    }
    if (
      existing.kind === "member_clone" &&
      existing.cloneForUserId !== userId
    ) {
      throw new BadRequestException(
        "Only the clone's owner can delete this agent"
      );
    }

    await this.prisma.client.agent.delete({ where: { id: agentId } });
    this.logger.log(
      `Agent deleted: id=${agentId} workspace=${workspaceId} by user=${userId}`
    );
    return { ok: true };
  }

  /**
   * Create a member-clone agent for the calling user. Seeded via Haiku from
   * their profile + recent messages. Users can have multiple clones (slug
   * collisions are auto-suffixed).
   */
  async createClone(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);

    const seed = await this.cloneSeed.generate({ userId, workspaceId });
    const slug = await this.uniqueSlug(workspaceId, seed.name);
    const greetingTemplate = await this.greetings.generate({
      workspaceId,
      name: seed.name,
      description: seed.description,
      systemPrompt: seed.systemPrompt,
    });

    const agent = await this.prisma.client.agent.create({
      data: {
        workspaceId,
        slug,
        name: seed.name,
        description: seed.description,
        systemPrompt: seed.systemPrompt,
        greetingTemplate,
        toolToggles: Prisma.DbNull,
        builtIn: false,
        kind: "member_clone",
        cloneForUserId: userId,
      },
    });
    this.logger.log(
      `Clone created: id=${agent.id} slug=${slug} workspace=${workspaceId} owner=${userId}`
    );
    return { id: agent.id, slug: agent.slug };
  }

  async setEnvDisabled(
    userId: string,
    workspaceId: string,
    envId: string,
    agentId: string,
    disabled: boolean
  ) {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
    const agent = await this.prisma.client.agent.findUnique({
      where: { id: agentId },
      select: { workspaceId: true },
    });
    if (!agent || agent.workspaceId !== workspaceId) {
      throw new NotFoundException("Agent not found");
    }

    if (disabled) {
      await this.prisma.client.envAgentDisabled.upsert({
        where: { envId_agentId: { envId, agentId } },
        create: { envId, agentId },
        update: {},
      });
    } else {
      await this.prisma.client.envAgentDisabled
        .delete({ where: { envId_agentId: { envId, agentId } } })
        .catch(() => {
          /* already absent — treat as idempotent */
        });
    }
    return { disabled };
  }

  private async uniqueSlug(
    workspaceId: string,
    name: string
  ): Promise<string> {
    const base = slugifyName(name);
    let slug = base;
    let n = 1;
    while (true) {
      const existing = await this.prisma.client.agent.findUnique({
        where: { workspaceId_slug: { workspaceId, slug } },
        select: { id: true },
      });
      if (!existing) return slug;
      n += 1;
      slug = `${base}-${n}`;
    }
  }
}

function sanitizeToolToggles(
  raw: ToolToggles | null | undefined
): ToolToggles | null {
  if (raw === null || raw === undefined) return null;
  const out: ToolToggles = {};
  for (const k of TOOL_TOGGLE_KEYS) {
    if (typeof raw[k] === "boolean") out[k] = raw[k];
  }
  return Object.keys(out).length ? out : null;
}
