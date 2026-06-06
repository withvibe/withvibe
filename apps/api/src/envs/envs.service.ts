import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { execFile } from "child_process";
import { promisify } from "util";

const execGit = promisify(execFile);
import {
  type EnvStatus,
  type ChatEngine,
  type QaBrowserMode,
} from "@withvibe/db";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { DemoModeService } from "../common/demo-mode.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import { AgentSeedService } from "../agents/agent-seed.service";
import { DockerService } from "../docker/docker.service";
import {
  assertComposeStringSafe,
  ComposeSecurityError,
} from "../docker/compose-security";
import { TemplateMaterializerService } from "../templates/template-materializer.service";
import { PortAllocatorService } from "../ports/port-allocator.service";
import { ClaudeRunnerService } from "../runner/claude-runner.service";
import { StorageService } from "../storage/storage.service";
import { ActiveRunsService } from "../chat/active-runs.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

const VALID_STATUSES: EnvStatus[] = ["todo", "in_progress", "done"];
const VALID_CHAT_ENGINES: ChatEngine[] = ["agent_sdk", "claude_code"];
const VALID_QA_BROWSER_MODES: QaBrowserMode[] = ["sidecar", "user_browser"];

type RepoBaseInput = { id: string; baseBranch: string | null };

export type EnvAssetMeta = { path: string; size: number; updatedAt: string };

export const ENV_ASSETS_SUBDIR = "assets";
export const MAX_ENV_ASSET_FILES = 500;
export const MAX_ENV_ASSET_PATH_LENGTH = 400;
export const MAX_ENV_ASSET_FILE_BYTES = 10 * 1024 * 1024; // 10 MB / file
export const MAX_ENV_ASSETS_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB / env

/**
 * Normalize a user-supplied relative path for storing under `assets/`.
 * Returns the canonical path or throws BadRequestException.
 */
export function normalizeAssetPath(p: string): string {
  const normalized = p.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0 || normalized.length > MAX_ENV_ASSET_PATH_LENGTH) {
    throw new BadRequestException(`Invalid asset path: "${p}"`);
  }
  const segs = normalized.split("/");
  if (
    segs.some((seg) => seg === "" || seg === "." || seg === "..") ||
    normalized.startsWith(".withvibe-")
  ) {
    throw new BadRequestException(`Invalid asset path: "${p}"`);
  }
  return normalized;
}

@Injectable()
export class EnvsService {
  constructor(
    @InjectPinoLogger(EnvsService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly demo: DemoModeService,
    private readonly envClones: EnvCloneService,
    private readonly agentSeed: AgentSeedService,
    private readonly docker: DockerService,
    private readonly templateMaterializer: TemplateMaterializerService,
    private readonly portAllocator: PortAllocatorService,
    private readonly runner: ClaudeRunnerService,
    private readonly storage: StorageService,
    private readonly activeRuns: ActiveRunsService
  ) {}

  async list(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);
    const envs = await this.prisma.client.env.findMany({
      where: { workspaceId, deletedAt: null },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        envRepos: { include: { repo: { select: { id: true, name: true } } } },
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return envs.map((e) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      status: e.status,
      containerStatus: e.containerStatus,
      containerPorts: e.containerPorts,
      serviceUrls: e.serviceUrls,
      lastContainerAt: e.lastContainerAt,
      createdAt: e.createdAt,
      createdBy: e.createdBy,
      repos: e.envRepos.map((er) => er.repo),
      messageCount: e._count.messages,
    }));
  }

  async detail(userId: string, workspaceId: string, envId: string) {
    const member = await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        envRepos: {
          include: {
            repo: {
              select: {
                id: true,
                name: true,
                url: true,
                clone: { select: { cloneStatus: true, branch: true } },
              },
            },
          },
        },
      },
    });

    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }

    // Runner status only matters when this env is on the claude_code engine.
    // Cheap docker CLI call — if claude_code isn't the selected engine, skip.
    const runnerStatus =
      env.chatEngine === "claude_code"
        ? await this.runner.uiStatus(envId).catch(() => "stopped" as const)
        : null;

    // Service readiness: the container can be "running" while the service
    // inside is still booting (e.g. a dev server doing npm install + first
    // compile). Derived from container healthchecks — false while any is still
    // "health: starting". Only probed when running (one cheap `docker ps`), and
    // defaults to true on error / for envs with no healthcheck so the preview
    // is never blocked. Lets the UI show "Service starting…".
    const serviceReady =
      env.containerStatus === "running"
        ? await this.docker
            .listEnvContainers(envId)
            .then((r) => r.serviceReady)
            .catch(() => true)
        : false;

    return {
      id: env.id,
      title: env.title,
      description: env.description,
      status: env.status,
      containerStatus: env.containerStatus,
      serviceReady,
      containerPorts: env.containerPorts,
      serviceUrls: env.serviceUrls,
      containerError: env.containerError,
      lastContainerAt: env.lastContainerAt,
      composeFile: env.composeFile,
      assetFiles: this.readAssetMeta(env.assetFiles),
      detectedDatabases: env.detectedDatabases,
      dbViewerPort: env.dbViewerPort,
      dbViewerStatus: env.dbViewerStatus,
      dbViewerError: env.dbViewerError,
      chatEngine: env.chatEngine,
      qaBrowserMode: env.qaBrowserMode,
      modelChoice: env.modelChoice,
      sandboxBypass: env.sandboxBypass,
      runnerStatus,
      createdAt: env.createdAt,
      createdBy: env.createdBy,
      repos: env.envRepos.map((er) => ({
        envRepoId: er.id,
        id: er.repo.id,
        name: er.repo.name,
        url: er.repo.url,
        cloneStatus: er.repo.clone?.cloneStatus || "pending",
        cloneBranch: er.repo.clone?.branch,
        baseBranch: er.baseBranch,
        envBranch: er.branch,
        envCloneStatus: er.envCloneStatus,
        envCloneError: er.envCloneError,
      })),
      canDelete: member.role === "admin" || env.createdById === userId,
    };
  }

  /**
   * Fail-fast compose check at save time so an obviously-dangerous paste is
   * rejected with a 400 immediately. NOT the security boundary — the
   * authoritative gate runs at start/rebuild in DockerService (it resolves
   * ${VAR}/extends/include and the realpath containment). This is purely UX.
   */
  private assertComposeOrBadRequest(yaml: string): void {
    try {
      // Best-effort save-time fail-fast on the RAW (pre-rewrite) compose,
      // which normally names no proxy network at all — the rewriter injects
      // the per-env external net later. We still allow the legacy shared
      // PROXY_NETWORK so a hand-authored compose referencing it isn't
      // rejected here; the authoritative runtime gate (DockerService) also
      // allows this env's per-env `<project>-edge` net.
      assertComposeStringSafe(yaml, {
        allowedExternalNetworks: [process.env.PROXY_NETWORK || "proxy"],
      });
    } catch (err) {
      if (err instanceof ComposeSecurityError)
        throw new BadRequestException(err.message);
      throw err;
    }
  }

  async create(
    userId: string,
    workspaceId: string,
    body: {
      title?: unknown;
      description?: unknown;
      repos?: unknown;
      composeFile?: unknown;
      templateId?: unknown;
      templateVars?: unknown;
      routingMode?: unknown;
      routingBaseDomain?: unknown;
      qaBrowserMode?: unknown;
    }
  ) {
    await this.access.member(userId, workspaceId);

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) throw new BadRequestException("Title is required");
    const description =
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : null;
    const userComposeFile =
      typeof body.composeFile === "string" && body.composeFile.trim()
        ? body.composeFile
        : null;

    const templateId =
      typeof body.templateId === "string" && body.templateId.trim()
        ? body.templateId.trim()
        : null;
    if (templateId && userComposeFile) {
      throw new BadRequestException(
        "Provide either a template or a custom compose file, not both"
      );
    }

    // Demo mode: the ONLY env a visitor may create is one from the
    // vibe-aquarium template, and at most one per workspace. Custom compose
    // files and any other template are rejected here (server-side boundary —
    // the UI gate in Phase 5 is cosmetic). The slug check is enforced below
    // once the template is resolved.
    if (this.demo.enabled) {
      if (userComposeFile) {
        throw new ForbiddenException(
          "Custom environments are disabled in demo mode"
        );
      }
      if (!templateId) {
        throw new ForbiddenException(
          "Only the vibe-aquarium demo environment can be created in demo mode"
        );
      }
      const liveCount = await this.prisma.client.env.count({
        where: { workspaceId, deletedAt: null },
      });
      if (liveCount >= 1) {
        throw new ForbiddenException(
          "This demo workspace already has its environment"
        );
      }
    }

    if (userComposeFile) this.assertComposeOrBadRequest(userComposeFile);
    const templateVars = this.parseTemplateVars(body.templateVars);

    let template: {
      slug: string;
      workspaceId: string;
      routingMode: "port" | "subdomain";
      routingBaseDomain: string | null;
      qaBrowserMode: QaBrowserMode;
      composeFile: string;
      repos: { repoId: string; baseBranch: string | null }[];
    } | null = null;
    if (templateId) {
      const tpl = await this.prisma.client.envTemplate.findUnique({
        where: { id: templateId },
        select: {
          id: true,
          slug: true,
          workspaceId: true,
          routingMode: true,
          routingBaseDomain: true,
          qaBrowserMode: true,
          composeFile: true,
          repos: { select: { repoId: true, baseBranch: true } },
        },
      });
      if (!tpl || tpl.workspaceId !== workspaceId) {
        throw new BadRequestException("Template not found in this workspace");
      }
      // Demo mode: only the vibe-aquarium template is permitted. Combined with
      // the workspace-scoping check above, this prevents pointing at any other
      // (or another workspace's) template.
      if (this.demo.enabled && tpl.slug !== this.demo.templateSlug) {
        throw new ForbiddenException(
          "Only the vibe-aquarium demo environment can be created in demo mode"
        );
      }
      // A template with an empty composeFile MUST attach exactly one repo —
      // the materializer will read that repo's own docker-compose.yml from
      // disk after we sync-clone it below.
      if (!tpl.composeFile.trim() && tpl.repos.length !== 1) {
        throw new BadRequestException(
          "Template has no composeFile and " +
            (tpl.repos.length === 0
              ? "no repos attached — attach exactly one repo whose root has a docker-compose.yml"
              : `${tpl.repos.length} repos attached — exactly one is required so we know which docker-compose.yml to use`)
        );
      }
      template = {
        slug: tpl.slug,
        workspaceId: tpl.workspaceId,
        routingMode: tpl.routingMode,
        routingBaseDomain: tpl.routingBaseDomain,
        qaBrowserMode: tpl.qaBrowserMode,
        composeFile: tpl.composeFile,
        repos: tpl.repos,
      };
    }

    // QA browser mode: template-backed envs inherit unconditionally (the
    // template author decides what mode to ship). Custom-compose envs let
    // the user pick at create time.
    const qaBrowserMode: QaBrowserMode = template
      ? template.qaBrowserMode
      : typeof body.qaBrowserMode === "string" &&
          (VALID_QA_BROWSER_MODES as string[]).includes(body.qaBrowserMode)
        ? (body.qaBrowserMode as QaBrowserMode)
        : "sidecar";

    // Routing config: a template-backed env inherits unconditionally (the
    // template owns the compose, so the mode must match what the template was
    // authored for). For custom-compose envs the client picks.
    let routingMode: "port" | "subdomain";
    let routingBaseDomain: string | null;
    if (template) {
      routingMode = template.routingMode;
      routingBaseDomain = template.routingBaseDomain;
    } else {
      routingMode =
        body.routingMode === "subdomain" || body.routingMode === "port"
          ? body.routingMode
          : "port";
      if (body.routingBaseDomain === null) {
        routingBaseDomain = null;
      } else if (typeof body.routingBaseDomain === "string") {
        routingBaseDomain = body.routingBaseDomain.trim() || null;
      } else {
        routingBaseDomain = null;
      }
      // Match the template-create default: subdomain without an explicit base
      // domain falls back to "localhost".
      if (routingMode === "subdomain" && !routingBaseDomain) {
        routingBaseDomain = "localhost";
      }
    }

    // Template with repos owns the repo *list*, but the client may still
    // override each repo's base branch at create time (the New Environment
    // form's per-repo branch picker). Overrides are keyed by repoId; an
    // absent or empty override falls back to the template's configured
    // branch, and entries for repos the template doesn't attach are ignored.
    // Without a template we use the client-provided repos wholesale.
    let repos: RepoBaseInput[];
    if (template && template.repos.length > 0) {
      const overrides = new Map<string, string | null>(
        (Array.isArray(body.repos) ? (body.repos as unknown[]) : [])
          .map((r) => this.parseRepoInput(r))
          .filter((r): r is RepoBaseInput => r !== null)
          .map((r) => [r.id, r.baseBranch] as const)
      );
      repos = template.repos.map((r) => ({
        id: r.repoId,
        baseBranch: overrides.get(r.repoId) ?? r.baseBranch,
      }));
    } else {
      repos = Array.isArray(body.repos)
        ? (body.repos as unknown[])
            .map((r) => this.parseRepoInput(r))
            .filter((r): r is RepoBaseInput => r !== null)
        : [];
      if (repos.length > 0) {
        const count = await this.prisma.client.repo.count({
          where: { id: { in: repos.map((r) => r.id) }, workspaceId },
        });
        if (count !== repos.length) {
          throw new BadRequestException(
            "Some repos do not belong to this workspace"
          );
        }
      }
    }

    this.logger.info(
      `Creating env "${title}" in workspace ${workspaceId} by user ${userId}` +
        (repos.length > 0 ? ` with ${repos.length} repo(s)` : "")
    );

    const env = await this.prisma.client.env.create({
      data: {
        workspaceId,
        title,
        description,
        composeFile: userComposeFile,
        templateId,
        templateVars: templateVars as unknown as object,
        routingMode,
        routingBaseDomain,
        qaBrowserMode,
        createdById: userId,
        envRepos: {
          create: repos.map((r) => ({
            repoId: r.id,
            baseBranch: r.baseBranch,
          })),
        },
        document: { create: {} },
      },
      include: {
        envRepos: {
          select: {
            id: true,
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

    // Seed QA session + greeting. QA's greeting is static and doesn't need
    // compose detection — it just orients the user to what QA can do here.
    // Created BEFORE DevOps so DevOps lands last and becomes the default-
    // selected session on a fresh env (chat picks the most recent).
    const qa = await this.agentSeed.ensureQaAgent(workspaceId);
    const qaRecord = await this.prisma.client.agent.findUnique({
      where: { id: qa.id },
      select: { name: true },
    });
    if (qaRecord) {
      const { content, suggestions } = await this.agentSeed.renderQaGreeting({
        envTitle: title,
        envDescription: description,
        repos: env.envRepos.map((er) => ({
          name: er.repo.name,
          cloneLocalPath: er.repo.clone?.localPath ?? null,
          cloneStatus: er.repo.clone?.cloneStatus ?? null,
        })),
      });
      const session = await this.prisma.client.chatSession.create({
        data: {
          envId: env.id,
          userId,
          agentId: qa.id,
          title: qaRecord.name,
        },
      });
      await this.prisma.client.message.create({
        data: {
          envId: env.id,
          userId,
          sessionId: session.id,
          role: "assistant",
          content,
          metadata: { suggestions },
        },
      });
    }

    // Seed Security session + greeting. Like QA, the greeting is static and
    // just orients the user — the agent itself runs `git diff` on first turn
    // to scope the review. Seeded between QA and DevOps so DevOps still lands
    // last and remains the default-selected session.
    const security = await this.agentSeed.ensureSecurityAgent(workspaceId);
    const securityRecord = await this.prisma.client.agent.findUnique({
      where: { id: security.id },
      select: { name: true },
    });
    if (securityRecord) {
      const { content, suggestions } =
        await this.agentSeed.renderSecurityGreeting({
          envTitle: title,
          envDescription: description,
          repos: env.envRepos.map((er) => ({
            name: er.repo.name,
            cloneLocalPath: er.repo.clone?.localPath ?? null,
            cloneStatus: er.repo.clone?.cloneStatus ?? null,
          })),
        });
      const session = await this.prisma.client.chatSession.create({
        data: {
          envId: env.id,
          userId,
          agentId: security.id,
          title: securityRecord.name,
        },
      });
      await this.prisma.client.message.create({
        data: {
          envId: env.id,
          userId,
          sessionId: session.id,
          role: "assistant",
          content,
          metadata: { suggestions },
        },
      });
    }

    // Seed DevOps session + greeting for the creating user. The greeting is
    // rendered after scanning each repo's clone for a docker-compose file so
    // the agent can open with context instead of interviewing the user.
    const devops = await this.agentSeed.ensureDevOpsAgent(workspaceId);
    const agentRecord = await this.prisma.client.agent.findUnique({
      where: { id: devops.id },
      select: { name: true },
    });
    if (agentRecord) {
      const { content, suggestions } = await this.agentSeed.renderDevOpsGreeting(
        {
          envTitle: title,
          envDescription: description,
          repos: env.envRepos.map((er) => ({
            name: er.repo.name,
            cloneLocalPath: er.repo.clone?.localPath ?? null,
            cloneStatus: er.repo.clone?.cloneStatus ?? null,
          })),
          userProvidedCompose: !!userComposeFile || !!templateId,
          // Demo envs auto-start after provisioning, so greet with a "ready"
          // message instead of asking the visitor to start the env.
          demoReady: this.demo.enabled,
        }
      );
      const session = await this.prisma.client.chatSession.create({
        data: {
          envId: env.id,
          userId,
          agentId: devops.id,
          title: agentRecord.name,
        },
      });
      await this.prisma.client.message.create({
        data: {
          envId: env.id,
          userId,
          sessionId: session.id,
          role: "assistant",
          content,
          metadata: { suggestions },
        },
      });
    }

    // Demo mode: seed an Orchestrator session (no bound agent) LAST so it is
    // the default-selected tab (sessions are ordered createdAt desc). The
    // Orchestrator can change application code, so a visitor who lands here and
    // says "add a feature" / "change the design" gets it built — instead of
    // landing on DevOps, which refuses code changes and tells them to switch
    // agents. The specialized agents (DevOps/QA/Security) remain available in
    // the sidebar.
    if (this.demo.enabled) {
      const orchestratorGreeting =
        `👋 Hi! I'm your build assistant for **${title}**.\n\n` +
        `Your environment is **already up and running**, so you can start ` +
        `right away. Tell me what you'd like to build or change — describe it ` +
        `in your own words (any language works) and I'll make it happen. ` +
        `Watch the live app update in the **preview** (👁 on the right).`;
      const orchestratorSession = await this.prisma.client.chatSession.create({
        data: {
          envId: env.id,
          userId,
          agentId: null,
          title: "Build",
        },
      });
      await this.prisma.client.message.create({
        data: {
          envId: env.id,
          userId,
          sessionId: orchestratorSession.id,
          role: "assistant",
          content: orchestratorGreeting,
          metadata: {
            suggestions: [
              "Add a new feature",
              "Change how it looks",
              "Fix something",
            ],
          },
        },
      });
    }

    // Materialize the custom compose on disk so the DevOps agent can read
    // it immediately. Asset files (schemas, configs) are uploaded via the
    // separate multipart endpoint and materialized under envDir/assets/.
    if (userComposeFile) {
      try {
        await this.storage.writeCompose(workspaceId, env.id, userComposeFile);
      } catch (err) {
        this.logger.error(
          `Failed to materialize custom compose for env ${env.id}: ${err}`
        );
      }
    } else if (templateId) {
      // Template path: materialize compose + assets + .env into the env dir.
      // We deliberately do NOT write env.composeFile here — the rendered
      // compose lives at `<envDir>/docker-compose.yml`, which is visible to
      // the DevOps agent on turn 1 and picked up by DockerService via its
      // env-root compose resolution path at Start time. Leaving the field
      // null keeps the UI's "paste your compose" editor out of the way.

      // When the template has no composeFile, the materializer needs to read
      // the repo's own docker-compose.yml from disk — but env-clones are
      // normally scheduled async after the 201 response. For this path only,
      // sync-clone the repo first so the file exists at materialize time.
      const templateUsesRepoCompose = !template?.composeFile.trim();
      if (templateUsesRepoCompose && env.envRepos.length > 0) {
        for (const er of env.envRepos) {
          const result = await this.envClones.ensureEnvClone(er.id);
          if ("error" in result) {
            await this.portAllocator.releaseForEnv(env.id).catch(() => {});
            await this.prisma.client.env.update({
              where: { id: env.id },
              data: { deletedAt: new Date() },
            });
            throw new BadRequestException(
              `Cannot materialize template "${template?.slug ?? templateId}": ` +
                `${result.error}. The template uses the repo's own ` +
                "docker-compose.yml so the repo must be cloned before the env " +
                "can start."
            );
          }
        }
      }

      try {
        await this.templateMaterializer.materialize({
          envId: env.id,
          workspaceId,
          templateId,
          userVars: templateVars,
        });
        this.logger.info(
          `Env ${env.id} materialized from template ${template?.slug ?? templateId}`
        );
      } catch (err) {
        // Best-effort rollback: release any ports we managed to grab, and
        // soft-delete the env so the UI doesn't show a broken shell.
        this.logger.error(
          `Template materialization failed for env ${env.id}: ${err}`
        );
        await this.portAllocator.releaseForEnv(env.id).catch(() => {});
        await this.prisma.client.env.update({
          where: { id: env.id },
          data: { deletedAt: new Date() },
        });
        throw err;
      }
    }

    this.logger.info(`Env created: ${env.id} ("${title}")`);

    // Background env-clone creation — detached so it can't delay the 201.
    const envRepoIds = env.envRepos.map((er) => er.id);
    if (envRepoIds.length > 0) {
      this.logger.info(
        `Scheduling env-clone setup for ${envRepoIds.length} repo(s) in env ${env.id}`
      );
    }
    const autoStart = this.demo.enabled;
    setImmediate(() => {
      void (async () => {
        try {
          if (!autoStart) {
            // Non-demo: fire-and-forget clone setup (the UI's Start handles the
            // build once clones are ready), preserving prior behavior.
            for (const id of envRepoIds) {
              void this.envClones.ensureEnvClone(id).catch((err) => {
                this.logger.error(`ensureEnvClone(${id}) failed: ${err}`);
              });
            }
            return;
          }
          // Demo mode: build + start the env automatically so a visitor can
          // start prompting immediately, without asking the DevOps agent to
          // bring it up. The env clone copies from the workspace repo, which is
          // still cloning in the background (workspaces.create → repos.add), so
          // ensureEnvClone returns { error: "not ready" } until that lands —
          // retry until every env clone is ready, THEN build + start.
          for (const id of envRepoIds) {
            const ok = await this.ensureEnvCloneReady(id, env.id);
            if (!ok) {
              this.logger.error(
                `Demo auto-start aborted: env clone ${id} not ready in time for env ${env.id}`
              );
              return;
            }
          }
          this.logger.info(`Demo auto-start: building + starting env ${env.id}`);
          await this.docker.startEnvironment(env.id);
        } catch (err) {
          this.logger.error(`env ${env.id} setup/auto-start failed: ${err}`);
        }
      })();
    });

    return { id: env.id };
  }

  /**
   * Poll ensureEnvClone until the env clone is fully materialized (its source
   * workspace repo finished its background clone). Returns false if it never
   * becomes ready within the budget. Used by demo auto-start so we don't kick
   * `docker compose up --build` before the build context exists.
   */
  private async ensureEnvCloneReady(
    envRepoId: string,
    envId: string,
    attempts = 60,
    delayMs = 3000
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.envClones.ensureEnvClone(envRepoId);
        if (res && "localPath" in res) return true;
        if (i === 0 || i % 5 === 0) {
          this.logger.info(
            `Waiting on env clone ${envRepoId} for env ${envId}: ${
              "error" in res ? res.error : "pending"
            } (attempt ${i + 1}/${attempts})`
          );
        }
      } catch (err) {
        this.logger.warn(`ensureEnvClone(${envRepoId}) threw: ${err}`);
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
  }

  async update(
    userId: string,
    workspaceId: string,
    envId: string,
    body: {
      title?: unknown;
      description?: unknown;
      status?: unknown;
      composeFile?: unknown;
      repos?: unknown;
      chatEngine?: unknown;
      qaBrowserMode?: unknown;
      modelChoice?: unknown;
      sandboxBypass?: unknown;
    }
  ) {
    await this.access.member(userId, workspaceId);
    const existing = await this.prisma.client.env.findUnique({
      where: { id: envId },
    });
    if (!existing || existing.workspaceId !== workspaceId || existing.deletedAt) {
      throw new NotFoundException("Env not found");
    }

    // Demo mode: block compose edits so a visitor can't swap the aquarium's
    // compose for arbitrary content after creation. Other edits (title,
    // description, status) remain allowed.
    if (this.demo.enabled && body.composeFile !== undefined) {
      throw new ForbiddenException(
        "Editing the environment compose is disabled in demo mode"
      );
    }

    const data: {
      title?: string;
      description?: string | null;
      status?: EnvStatus;
      composeFile?: string | null;
      chatEngine?: ChatEngine;
      qaBrowserMode?: QaBrowserMode;
      modelChoice?: string | null;
      sandboxBypass?: boolean | null;
    } = {};
    if (typeof body.title === "string" && body.title.trim()) {
      data.title = body.title.trim();
    }
    if (typeof body.description === "string") {
      data.description = body.description.trim() || null;
    }
    if (
      typeof body.status === "string" &&
      (VALID_STATUSES as string[]).includes(body.status)
    ) {
      data.status = body.status as EnvStatus;
    }
    if (body.composeFile === null) {
      data.composeFile = null;
    } else if (typeof body.composeFile === "string") {
      data.composeFile = body.composeFile.trim() ? body.composeFile : null;
      if (typeof data.composeFile === "string")
        this.assertComposeOrBadRequest(data.composeFile);
    }
    if (
      typeof body.chatEngine === "string" &&
      (VALID_CHAT_ENGINES as string[]).includes(body.chatEngine)
    ) {
      data.chatEngine = body.chatEngine as ChatEngine;
    }
    if (
      typeof body.qaBrowserMode === "string" &&
      (VALID_QA_BROWSER_MODES as string[]).includes(body.qaBrowserMode)
    ) {
      data.qaBrowserMode = body.qaBrowserMode as QaBrowserMode;
    }
    // modelChoice: null = inherit workspace default; "auto" or a concrete model
    // id pins this env. Anything else is ignored to keep the field a closed set.
    if (body.modelChoice === null) {
      data.modelChoice = null;
    } else if (
      typeof body.modelChoice === "string" &&
      (
        ["auto", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"] as string[]
      ).includes(body.modelChoice)
    ) {
      data.modelChoice = body.modelChoice;
    }
    // sandboxBypass: null = inherit workspace/deployment; true/false force
    // Claude Bypass Permissions on/off for this env's `code tunnel`.
    if (body.sandboxBypass === null || typeof body.sandboxBypass === "boolean") {
      data.sandboxBypass = body.sandboxBypass;
    }

    const reposChanged = Array.isArray(body.repos);
    const repos: RepoBaseInput[] = reposChanged
      ? (body.repos as unknown[])
          .map((r) => this.parseRepoInput(r))
          .filter((r): r is RepoBaseInput => r !== null)
      : [];

    if (reposChanged && repos.length > 0) {
      const count = await this.prisma.client.repo.count({
        where: { id: { in: repos.map((r) => r.id) }, workspaceId },
      });
      if (count !== repos.length) {
        throw new BadRequestException(
          "Some repos do not belong to this workspace"
        );
      }
    }

    // Diff existing vs desired outside the transaction so we can schedule
    // env-clone work on just the changed rows, preserving existing ones.
    const existingEnvRepos = reposChanged
      ? await this.prisma.client.envRepo.findMany({
          where: { envId },
          select: { id: true, repoId: true },
        })
      : [];
    const existingByRepoId = new Map(
      existingEnvRepos.map((er) => [er.repoId, er.id])
    );
    const desiredRepoIds = new Set(repos.map((r) => r.id));
    const toRemove = existingEnvRepos.filter(
      (er) => !desiredRepoIds.has(er.repoId)
    );
    const toAdd = repos.filter((r) => !existingByRepoId.has(r.id));

    const addedEnvRepoIds: string[] = [];
    const changedFields = Object.keys(data);
    this.logger.info(
      `Updating env ${envId}: fields=[${changedFields.join(", ") || "none"}]` +
        (reposChanged ? ` repos: +${toAdd.length} -${toRemove.length}` : "")
    );

    await this.prisma.client.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.env.update({ where: { id: envId }, data });
      }
      if (reposChanged) {
        if (toRemove.length > 0) {
          await tx.envRepo.deleteMany({
            where: { id: { in: toRemove.map((er) => er.id) } },
          });
        }
        for (const r of toAdd) {
          const created = await tx.envRepo.create({
            data: { envId, repoId: r.id, baseBranch: r.baseBranch },
            select: { id: true },
          });
          addedEnvRepoIds.push(created.id);
        }
      }
    });

    // Keep the durable custom compose in sync with DB changes so the agent
    // sees the edit without waiting for start.
    if (data.composeFile !== undefined) {
      try {
        if (data.composeFile === null) {
          await this.storage.deleteCompose(workspaceId, envId);
        } else if (typeof data.composeFile === "string") {
          await this.storage.writeCompose(workspaceId, envId, data.composeFile);
        }
      } catch (err) {
        this.logger.error(
          `Failed to sync custom compose for env ${envId}: ${err}`
        );
      }
    }

    for (const er of toRemove) {
      void this.envClones.removeEnvClone(er.id).catch(() => {});
    }
    for (const envRepoId of addedEnvRepoIds) {
      void this.envClones.ensureEnvClone(envRepoId).catch(() => {});
    }

    return { ok: true };
  }

  async delete(
    userId: string,
    workspaceId: string,
    envId: string,
    options: { deleteRemoteBranch?: boolean } = {}
  ) {
    const member = await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }

    const canDelete = member.role === "admin" || env.createdById === userId;
    if (!canDelete) {
      throw new ForbiddenException(
        "Only the creator or a workspace admin can delete this env"
      );
    }

    this.logger.info(
      `Deleting env ${envId} ("${env.title}") by user ${userId}` +
        (options.deleteRemoteBranch ? " [+remote branch delete]" : "")
    );

    // Step 1 (synchronous): abort any in-flight agent turn for this env so a
    // mid-build orchestrator stops writing into the clone path before we
    // start tearing it down. The abort signal propagates to the SDK / runner
    // child process within a few hundred ms; we don't block on the run
    // settling here — the soft delete below is authoritative regardless.
    const aborted = this.activeRuns.abortAllForEnv(envId);
    if (aborted > 0) {
      // Give the AbortControllers a moment to propagate to file writes so
      // they don't race the clone removal below. 250ms is plenty for the
      // SDK to break out of its async iterator on the next tick.
      await new Promise((r) => setTimeout(r, 250));
    }

    await this.prisma.client.env.update({
      where: { id: envId },
      data: { deletedAt: new Date() },
    });

    this.logger.info(
      `Env ${envId} soft-deleted; stopping container + tearing down env clones`
    );

    // Stop running container, then tear down env clones. Fire-and-forget —
    // the soft delete is the authoritative signal to the UI. Port rows are
    // released after stop so the host ports stay reserved until compose has
    // actually released them on the network side.
    void (async () => {
      try {
        await this.docker.stopEnvironment(envId);
      } catch {
        // already logged by docker service
      }
      try {
        await this.portAllocator.releaseForEnv(envId);
      } catch (err) {
        this.logger.error(
          `Failed to release ports for env ${envId}: ${err}`
        );
      }
    })();
    void this.envClones
      .removeEnvClones(envId, {
        deleteRemoteBranch: options.deleteRemoteBranch === true,
      })
      .catch((err) =>
        this.logger.error(`Failed to tear down env clones for ${envId}: ${err}`)
      );
    void this.storage
      .deleteEnv(env.workspaceId, envId)
      .catch((err) =>
        this.logger.error(`Failed to drop storage for env ${envId}: ${err}`)
      );
    return { ok: true };
  }

  /**
   * Produce everything the CLI needs to stand up this env on a user machine.
   * Works for envs of any `mode`; the CLI just receives data and never touches
   * server-side state. Port allocation happens locally on the user's machine.
   */
  async localBundle(userId: string, envId: string) {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      include: {
        envRepos: {
          include: {
            repo: { select: { id: true, name: true, url: true } },
          },
        },
      },
    });
    if (!env || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
    await this.access.member(userId, env.workspaceId);

    const templateVars = this.parseTemplateVars(env.templateVars);

    let bundle:
      | { kind: "template"; composeFile: string; resolvedVars: Record<string, string>; portKeys: string[]; assets: { path: string; content: string; isTemplate: boolean }[] }
      | { kind: "custom"; composeFile: string }
      | { kind: "none" };
    if (env.templateId) {
      bundle = await this.templateMaterializer.renderBundleForTemplate({
        templateId: env.templateId,
        workspaceId: env.workspaceId,
        userVars: templateVars,
      });
    } else if (env.composeFile) {
      bundle = { kind: "custom", composeFile: env.composeFile };
    } else {
      bundle = { kind: "none" };
    }

    return {
      env: {
        id: env.id,
        title: env.title,
        description: env.description,
        workspaceId: env.workspaceId,
      },
      repos: env.envRepos.map((er) => {
        if (!er.branch) {
          throw new BadRequestException(
            `Env branch not yet created for repo "${er.repo.name}" — wait for the server clone to finish before exporting.`
          );
        }
        return {
          name: er.repo.name,
          url: er.repo.url,
          branch: er.branch,
        };
      }),
      bundle,
    };
  }

  /**
   * Inspect each env clone on the server to surface uncommitted/unpushed work
   * before the CLI exports. The CLI clones from GitHub, so anything not
   * committed and pushed to `origin/<branch>` will not appear locally.
   */
  async exportReadiness(userId: string, envId: string) {
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      include: {
        envRepos: {
          include: { repo: { select: { name: true } } },
        },
      },
    });
    if (!env || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
    await this.access.member(userId, env.workspaceId);

    const repos = await Promise.all(
      env.envRepos.map(async (er) => {
        const name = er.repo.name;
        const branch = er.branch;
        if (!branch) {
          return {
            name,
            branch: null,
            uncommitted: 0,
            unpushed: 0,
            error: "Env branch not yet created on the server.",
          };
        }
        if (!er.envClonePath) {
          return {
            name,
            branch,
            uncommitted: 0,
            unpushed: 0,
            error: "Server clone not ready yet.",
          };
        }
        try {
          const cwd = er.envClonePath;
          const opts = { timeout: 10_000 };
          const { stdout: status } = await execGit(
            "git",
            ["-C", cwd, "status", "--porcelain"],
            opts
          );
          const uncommitted = status
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean).length;

          await execGit(
            "git",
            ["-C", cwd, "fetch", "origin", branch],
            { ...opts, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
          ).catch(() => {});

          let unpushed = 0;
          try {
            const { stdout: ahead } = await execGit(
              "git",
              ["-C", cwd, "rev-list", "--count", `origin/${branch}..HEAD`],
              opts
            );
            unpushed = parseInt(ahead.trim(), 10) || 0;
          } catch {
            unpushed = 0;
          }

          return { name, branch, uncommitted, unpushed, error: null };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            name,
            branch,
            uncommitted: 0,
            unpushed: 0,
            error: `git inspection failed: ${msg}`,
          };
        }
      })
    );

    const ready = repos.every(
      (r) => !r.error && r.uncommitted === 0 && r.unpushed === 0
    );

    return { ready, repos };
  }

  private parseTemplateVars(raw: unknown): Record<string, string> {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object" || Array.isArray(raw)) {
      throw new BadRequestException(
        "templateVars must be an object mapping variable key to string value"
      );
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new BadRequestException(
          `templateVars["${k}"] must be a string`
        );
      }
      out[k] = v;
    }
    return out;
  }

  private parseRepoInput(r: unknown): RepoBaseInput | null {
    if (typeof r !== "object" || r === null) return null;
    const rr = r as { id?: unknown; baseBranch?: unknown };
    if (typeof rr.id !== "string") return null;
    const baseBranch =
      typeof rr.baseBranch === "string" && rr.baseBranch.trim()
        ? rr.baseBranch.trim()
        : null;
    return { id: rr.id, baseBranch };
  }

  private readAssetMeta(raw: unknown): EnvAssetMeta[] {
    if (!Array.isArray(raw)) return [];
    const out: EnvAssetMeta[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const { path: p, size, updatedAt } = item as {
        path?: unknown;
        size?: unknown;
        updatedAt?: unknown;
      };
      if (
        typeof p === "string" &&
        typeof size === "number" &&
        typeof updatedAt === "string"
      ) {
        out.push({ path: p, size, updatedAt });
      }
    }
    return out;
  }
}
