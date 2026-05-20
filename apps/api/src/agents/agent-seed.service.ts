import { Injectable } from "@nestjs/common";
import { access } from "fs/promises";
import path from "path";
import { PrismaService } from "../prisma/prisma.service";
import {
  DEVOPS_AGENT,
  DEVOPS_GREETING_SUGGESTIONS,
  QA_AGENT,
  QA_GREETING_SUGGESTIONS,
  SECURITY_AGENT,
  SECURITY_GREETING_SUGGESTIONS,
  renderDevOpsGreeting,
  renderQaGreeting,
  renderSecurityGreeting,
  type ComposeDetection,
} from "./_seed-data";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

const COMPOSE_FILENAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

type RepoScanInput = {
  name: string;
  cloneLocalPath: string | null;
  cloneStatus: string | null;
};

/**
 * DB-side of agent seeding — creates the built-in DevOps agent + its seed
 * skills for a workspace, and renders the greeting message.
 *
 * Called from env create (to seed + greet) and from workspace create
 * (future). The full Agents module in Phase 2e adds CRUD + save_skill MCP.
 */
@Injectable()
export class AgentSeedService {
  constructor(
    @InjectPinoLogger(AgentSeedService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService
  ) {}

  async ensureDevOpsAgent(
    workspaceId: string
  ): Promise<{ id: string; created: boolean }> {
    return this.ensureBuiltInAgent(workspaceId, DEVOPS_AGENT, 0);
  }

  async ensureQaAgent(
    workspaceId: string
  ): Promise<{ id: string; created: boolean }> {
    return this.ensureBuiltInAgent(workspaceId, QA_AGENT, 1);
  }

  async ensureSecurityAgent(
    workspaceId: string
  ): Promise<{ id: string; created: boolean }> {
    return this.ensureBuiltInAgent(workspaceId, SECURITY_AGENT, 2);
  }

  private async ensureBuiltInAgent(
    workspaceId: string,
    spec: { slug: string; name: string; description: string; systemPrompt: string; greetingTemplate: string; seedSkills: { slug: string; name: string; description: string; content: string }[] },
    position: number
  ): Promise<{ id: string; created: boolean }> {
    const existing = await this.prisma.client.agent.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: spec.slug } },
    });
    if (existing) {
      await this.addMissingSeedSkills(existing.id, spec);
      return { id: existing.id, created: false };
    }

    const agent = await this.prisma.client.agent.create({
      data: {
        workspaceId,
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        systemPrompt: spec.systemPrompt,
        greetingTemplate: spec.greetingTemplate,
        builtIn: true,
        pinned: true,
        position,
      },
    });

    await this.prisma.client.agentSkill.createMany({
      data: spec.seedSkills.map((s) => ({
        agentId: agent.id,
        scope: "workspace",
        envId: null,
        slug: s.slug,
        name: s.name,
        description: s.description,
        content: s.content,
        source: "seed",
      })),
    });

    return { id: agent.id, created: true };
  }

  // Adds any seed skills that don't yet exist on an already-seeded built-in
  // agent. Leaves existing rows (possibly user-edited) alone — we only fill
  // gaps. Runs every ensure*Agent call so new seed skills roll out on the
  // next env/workspace interaction.
  private async addMissingSeedSkills(
    agentId: string,
    spec: { slug: string; seedSkills: { slug: string; name: string; description: string; content: string }[] }
  ): Promise<void> {
    const present = await this.prisma.client.agentSkill.findMany({
      where: { agentId, scope: "workspace" },
      select: { slug: true },
    });
    const presentSlugs = new Set(present.map((s) => s.slug));
    const missing = spec.seedSkills.filter((s) => !presentSlugs.has(s.slug));
    if (missing.length === 0) return;
    await this.prisma.client.agentSkill.createMany({
      data: missing.map((s) => ({
        agentId,
        scope: "workspace",
        envId: null,
        slug: s.slug,
        name: s.name,
        description: s.description,
        content: s.content,
        source: "seed",
      })),
    });
    this.logger.info(
      `${spec.slug} agent ${agentId}: added ${missing.length} missing seed skill(s): ${missing.map((s) => s.slug).join(", ")}`
    );
  }

  /**
   * Scan each attached repo's main clone for a docker-compose file. Returns the
   * first hit found. Falls back to `{found: false}` on missing/unready clones
   * or any fs error — detection is best-effort and must never block env create.
   */
  async detectCompose(repos: RepoScanInput[]): Promise<ComposeDetection> {
    for (const repo of repos) {
      if (!repo.cloneLocalPath || repo.cloneStatus !== "ready") continue;
      for (const filename of COMPOSE_FILENAMES) {
        try {
          await access(path.join(repo.cloneLocalPath, filename));
          return { found: true, source: "repo", repoName: repo.name, filename };
        } catch {
          // file missing or unreadable — try next candidate
        }
      }
    }
    return { found: false };
  }

  /**
   * If the DevOps chat session for this env still only has its single
   * auto-generated greeting (i.e. the user hasn't replied yet), re-render
   * that greeting using current env state. Lets asset uploads flowing in
   * after env creation propagate into the agent's opening message without
   * touching an in-progress conversation.
   */
  async refreshDevOpsGreetingIfUnused(envId: string): Promise<void> {
    this.logger.info(`refreshGreeting: called for env ${envId}`);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: {
        title: true,
        description: true,
        composeFile: true,
        assetFiles: true,
        workspaceId: true,
        envRepos: {
          select: {
            repo: {
              select: {
                name: true,
                clone: { select: { localPath: true, cloneStatus: true } },
              },
            },
          },
        },
      },
    });
    if (!env) {
      this.logger.info(`refreshGreeting: env ${envId} not found`);
      return;
    }

    const devops = await this.prisma.client.agent.findUnique({
      where: {
        workspaceId_slug: {
          workspaceId: env.workspaceId,
          slug: DEVOPS_AGENT.slug,
        },
      },
      select: { id: true },
    });
    if (!devops) {
      this.logger.info(`refreshGreeting: no DevOps agent in ws ${env.workspaceId}`);
      return;
    }

    const session = await this.prisma.client.chatSession.findFirst({
      where: { envId, agentId: devops.id },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          select: { id: true, role: true },
        },
      },
    });
    if (!session) {
      this.logger.info(`refreshGreeting: no DevOps session for env ${envId}`);
      return;
    }
    // Refresh only if the user hasn't replied yet — rewriting the greeting
    // after the conversation started would desync the agent's context.
    const hasUserMessage = session.messages.some((m) => m.role === "user");
    if (hasUserMessage) {
      this.logger.info(
        `refreshGreeting: env ${envId} already has user messages — skip`
      );
      return;
    }
    const greeting = session.messages.find((m) => m.role === "assistant");
    if (!greeting) {
      this.logger.info(
        `refreshGreeting: env ${envId} has no assistant greeting to update`
      );
      return;
    }

    const assetPaths = Array.isArray(env.assetFiles)
      ? (env.assetFiles as Array<{ path?: unknown }>)
          .map((a) => (typeof a?.path === "string" ? a.path : null))
          .filter((p): p is string => !!p)
      : [];

    const { content, suggestions } = await this.renderDevOpsGreeting({
      envTitle: env.title,
      envDescription: env.description,
      repos: env.envRepos.map((er) => ({
        name: er.repo.name,
        cloneLocalPath: er.repo.clone?.localPath ?? null,
        cloneStatus: er.repo.clone?.cloneStatus ?? null,
      })),
      userProvidedCompose: !!env.composeFile,
      assetPaths,
    });

    await this.prisma.client.message.update({
      where: { id: greeting.id },
      data: { content, metadata: { suggestions } },
    });
    this.logger.info(
      `Refreshed DevOps greeting for env ${envId} with ${assetPaths.length} asset(s)`
    );
  }

  async renderQaGreeting(vars: {
    envTitle: string;
    envDescription: string | null;
    repos: RepoScanInput[];
  }): Promise<{ content: string; suggestions: string[] }> {
    const content = renderQaGreeting({
      envTitle: vars.envTitle,
      envDescription: vars.envDescription,
      repos: vars.repos.map((r) => r.name),
    });
    return { content, suggestions: QA_GREETING_SUGGESTIONS };
  }

  async renderSecurityGreeting(vars: {
    envTitle: string;
    envDescription: string | null;
    repos: RepoScanInput[];
  }): Promise<{ content: string; suggestions: string[] }> {
    const content = renderSecurityGreeting({
      envTitle: vars.envTitle,
      envDescription: vars.envDescription,
      repos: vars.repos.map((r) => r.name),
    });
    return { content, suggestions: SECURITY_GREETING_SUGGESTIONS };
  }

  async renderDevOpsGreeting(vars: {
    envTitle: string;
    envDescription: string | null;
    repos: RepoScanInput[];
    userProvidedCompose?: boolean;
    /** Paths (relative to `<envDir>/assets/`) of user-uploaded files. */
    assetPaths?: string[];
  }): Promise<{ content: string; suggestions: string[] }> {
    const assetHasCompose = (vars.assetPaths ?? []).some((p) => {
      const name = p.split("/").pop() ?? "";
      return COMPOSE_FILENAMES.includes(name);
    });
    const compose: ComposeDetection =
      vars.userProvidedCompose || assetHasCompose
        ? { found: true, source: "user-provided" }
        : await this.detectCompose(vars.repos);
    const content = renderDevOpsGreeting({
      envTitle: vars.envTitle,
      envDescription: vars.envDescription,
      repos: vars.repos.map((r) => r.name),
      compose,
      assetPaths: vars.assetPaths,
    });
    return { content, suggestions: DEVOPS_GREETING_SUGGESTIONS };
  }
}
