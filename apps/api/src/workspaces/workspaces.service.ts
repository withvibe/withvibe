import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { AgentSeedService } from "../agents/agent-seed.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import { StorageService } from "../storage/storage.service";
import { ReposService } from "../repos/repos.service";
import { SlackService } from "../slack/slack.service";
import { SlackSocketService } from "../slack/slack-socket.service";
import { getAppVersion } from "../common/version";

export type CreateWorkspaceInput = {
  name: string;
  description?: string | null;
};

type DemoTemplateSpec = {
  matchRepoUrl: string;
  slug: string;
  name: string;
  description: string;
  composeFile: string;
  routingMode: "port" | "subdomain";
  routingBaseDomain: string | null;
  services: Array<{
    name: string;
    role?: string;
    userFacing?: boolean;
    description?: string;
  }>;
};

const VIBE_AQUARIUM_COMPOSE = `services:
  aquarium:
    build:
      context: ./vibe-aquarium
    ports:
      - "3000:3000"
    environment:
      NODE_ENV: production
      DB_PATH: /app/data/aquarium.db
    volumes:
      - aquarium-data:/app/data
    restart: unless-stopped

volumes:
  aquarium-data:
`;

const DEMO_TEMPLATE_SPECS: DemoTemplateSpec[] = [
  {
    matchRepoUrl: "https://github.com/withvibe/vibe-aquarium.git",
    slug: "vibe-aquarium",
    name: "vibe-aquarium",
    description: "vibe-aquarium",
    composeFile: VIBE_AQUARIUM_COMPOSE,
    routingMode: "subdomain",
    // Self-hosters point this at their own wildcard domain via
    // WITHVIBE_ROUTING_BASE_DOMAIN (the CLI sets it at install time). When
    // unset we fall back to "localhost" — NOT a vendor domain — so local /
    // from-source installs don't route env URLs at withvibe.dev. Mirrors the
    // per-env fallback in EnvsService.
    routingBaseDomain:
      process.env.WITHVIBE_ROUTING_BASE_DOMAIN || "localhost",
    services: [],
  },
];

function canonicalizeRepoUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
}

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectPinoLogger(WorkspacesService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly agentSeed: AgentSeedService,
    private readonly envClones: EnvCloneService,
    private readonly storage: StorageService,
    private readonly repos: ReposService,
    private readonly slack: SlackService,
    private readonly slackSockets: SlackSocketService
  ) {}

  async create(userId: string, input: CreateWorkspaceInput) {
    const workspace = await this.prisma.client.workspace.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        members: {
          create: {
            userId,
            role: "admin",
          },
        },
      },
    });
    await this.agentSeed.ensureDevOpsAgent(workspace.id);
    await this.agentSeed.ensureQaAgent(workspace.id);
    await this.agentSeed.ensureSecurityAgent(workspace.id);

    const demoUrls = (process.env.DEMO_TEMPLATE_REPOS ?? "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    for (const url of demoUrls) {
      try {
        const { id: repoId } = await this.repos.add(userId, workspace.id, url);
        const canonical = canonicalizeRepoUrl(url);
        const spec = DEMO_TEMPLATE_SPECS.find(
          (s) => s.matchRepoUrl === canonical
        );
        if (spec) {
          await this.ensureDemoTemplate(workspace.id, repoId, spec);
        }
      } catch (err) {
        this.logger.warn(
          `demo seed failed for ${url}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return { id: workspace.id };
  }

  private async ensureDemoTemplate(
    workspaceId: string,
    repoId: string,
    spec: DemoTemplateSpec
  ): Promise<void> {
    const existing = await this.prisma.client.envTemplate.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: spec.slug } },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.client.envTemplate.create({
      data: {
        workspaceId,
        slug: spec.slug,
        name: spec.name,
        description: spec.description,
        composeFile: spec.composeFile,
        variables: [],
        routingMode: spec.routingMode,
        routingBaseDomain: spec.routingBaseDomain,
        qaBrowserMode: "sidecar",
        services: spec.services,
        repos: {
          create: [{ repoId, baseBranch: null }],
        },
      },
    });
    this.logger.info(
      `Demo template seeded: ${spec.slug} (workspace=${workspaceId})`
    );
  }

  /**
   * List the workspaces this user is a member of, ordered by most-recently
   * joined. Soft-deleted workspaces are filtered out.
   */
  async listForUser(userId: string) {
    const memberships = await this.prisma.client.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          select: { id: true, name: true, deletedAt: true },
        },
      },
      orderBy: { joinedAt: "desc" },
    });
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { defaultWorkspaceId: true },
    });
    return {
      defaultWorkspaceId: user?.defaultWorkspaceId ?? null,
      memberships: memberships
        .filter((m) => !m.workspace.deletedAt)
        .map((m) => ({
          workspaceId: m.workspaceId,
          role: m.role,
          joinedAt: m.joinedAt,
          workspace: { id: m.workspace.id, name: m.workspace.name },
        })),
    };
  }

  /**
   * Server-side bootstrap data for the workspace shell. Replaces the
   * direct Prisma calls the web `WorkspaceLayout` used to make.
   */
  async bootstrap(userId: string, workspaceId: string) {
    const member = await this.access.member(userId, workspaceId);
    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        anthropicApiKey: true,
        githubToken: true,
      },
    });
    if (!workspace || workspace.deletedAt) {
      throw new NotFoundException("Workspace not found");
    }

    const [allMemberships, currentUser] = await Promise.all([
      this.prisma.client.workspaceMember.findMany({
        where: { userId },
        include: {
          workspace: { select: { id: true, name: true, deletedAt: true } },
        },
        orderBy: { joinedAt: "desc" },
      }),
      this.prisma.client.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          defaultWorkspaceId: true,
        },
      }),
    ]);

    // Deployment admin is derived from workspace memberships.
    const isDeploymentAdmin = allMemberships.some((m) => m.role === "admin");

    return {
      version: await getAppVersion(),
      workspace: { id: workspace.id, name: workspace.name },
      role: member.role,
      user: {
        id: currentUser?.id ?? userId,
        name: currentUser?.name ?? null,
        email: currentUser?.email ?? "",
        isDeploymentAdmin,
      },
      workspaces: allMemberships
        .filter((m) => !m.workspace.deletedAt)
        .map((m) => ({ id: m.workspace.id, name: m.workspace.name })),
      defaultWorkspaceId: currentUser?.defaultWorkspaceId ?? null,
      integrations: {
        anthropic: Boolean(
          workspace.anthropicApiKey || process.env.ANTHROPIC_API_KEY
        ),
        github: Boolean(workspace.githubToken || process.env.GITHUB_TOKEN),
      },
    };
  }

  async detail(userId: string, workspaceId: string) {
    const member = await this.access.member(userId, workspaceId);
    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        _count: { select: { members: true, envs: true, repos: true } },
      },
    });
    if (!workspace || workspace.deletedAt) {
      throw new NotFoundException("Workspace not found");
    }

    return {
      id: workspace.id,
      name: workspace.name,
      description: workspace.description,
      memberCount: workspace._count.members,
      envCount: workspace._count.envs,
      repoCount: workspace._count.repos,
      role: member.role,
      anthropicConnected: Boolean(
        workspace.anthropicApiKey || process.env.ANTHROPIC_API_KEY
      ),
      githubConnected: Boolean(
        workspace.githubToken || process.env.GITHUB_TOKEN
      ),
      anthropicWorkspaceSet: Boolean(workspace.anthropicApiKey),
      githubWorkspaceSet: Boolean(workspace.githubToken),
    };
  }

  async getIntegrations(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);
    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        anthropicApiKey: true,
        githubToken: true,
        slackBotToken: true,
        slackAppToken: true,
        slackTeamName: true,
        allowDirectMerge: true,
        debugMode: true,
        defaultModel: true,
        sandboxBypass: true,
      },
    });
    const envAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
    const envGithub = Boolean(process.env.GITHUB_TOKEN);
    const slackBotSet = Boolean(workspace?.slackBotToken);
    const slackAppSet = Boolean(workspace?.slackAppToken);
    return {
      anthropic: {
        workspaceSet: Boolean(workspace?.anthropicApiKey),
        envFallback: envAnthropic,
        connected: Boolean(workspace?.anthropicApiKey) || envAnthropic,
      },
      github: {
        workspaceSet: Boolean(workspace?.githubToken),
        envFallback: envGithub,
        connected: Boolean(workspace?.githubToken) || envGithub,
      },
      slack: {
        workspaceSet: slackBotSet,
        connected: slackBotSet,
        teamName: workspace?.slackTeamName ?? null,
        appTokenSet: slackAppSet,
        // Two-way ask/answer needs BOTH tokens — bot for posting, app for
        // Socket Mode event delivery.
        twoWayEnabled: slackBotSet && slackAppSet,
      },
      allowDirectMerge: Boolean(workspace?.allowDirectMerge),
      debugMode: Boolean(workspace?.debugMode),
      defaultModel: workspace?.defaultModel ?? "auto",
      // null = inherit the deployment IS_SANDBOX default (tri-state).
      sandboxBypass: workspace?.sandboxBypass ?? null,
    };
  }

  async updateIntegrations(
    userId: string,
    workspaceId: string,
    body: {
      anthropicApiKey?: string | null;
      githubToken?: string | null;
      slackBotToken?: string | null;
      slackAppToken?: string | null;
      allowDirectMerge?: boolean;
      debugMode?: boolean;
      defaultModel?: string;
      sandboxBypass?: boolean | null;
    }
  ) {
    await this.access.admin(userId, workspaceId);
    const data: {
      anthropicApiKey?: string | null;
      githubToken?: string | null;
      slackBotToken?: string | null;
      slackAppToken?: string | null;
      slackTeamId?: string | null;
      slackTeamName?: string | null;
      allowDirectMerge?: boolean;
      debugMode?: boolean;
      defaultModel?: string;
      sandboxBypass?: boolean | null;
    } = {};
    let slackTokenChanged = false;

    if (body.anthropicApiKey !== undefined) {
      data.anthropicApiKey =
        typeof body.anthropicApiKey === "string" && body.anthropicApiKey.trim()
          ? body.anthropicApiKey.trim()
          : null;
    }
    if (body.githubToken !== undefined) {
      data.githubToken =
        typeof body.githubToken === "string" && body.githubToken.trim()
          ? body.githubToken.trim()
          : null;
    }
    // Slack: validate the token against Slack before storing — a bad token
    // should fail loudly at save time, not at first agent use. On disconnect
    // (null/empty), also clear the cached team metadata so the UI doesn't
    // show a stale team name.
    if (body.slackBotToken !== undefined) {
      const trimmed =
        typeof body.slackBotToken === "string" ? body.slackBotToken.trim() : "";
      if (trimmed) {
        let info;
        try {
          info = await this.slack.testToken(trimmed);
        } catch (err) {
          throw new BadRequestException(
            err instanceof Error ? err.message : "Invalid Slack bot token"
          );
        }
        data.slackBotToken = trimmed;
        data.slackTeamId = info.teamId;
        data.slackTeamName = info.teamName;
      } else {
        data.slackBotToken = null;
        data.slackTeamId = null;
        data.slackTeamName = null;
      }
      slackTokenChanged = true;
    }
    // Slack app-level token: same posture as bot token. Validated by opening
    // (and immediately discarding) a Socket Mode connection — confirms the
    // token has the `connections:write` scope without committing to a live
    // listener here. The live socket is owned by SlackSocketService and gets
    // refreshed below.
    if (body.slackAppToken !== undefined) {
      const trimmed =
        typeof body.slackAppToken === "string" ? body.slackAppToken.trim() : "";
      if (trimmed) {
        try {
          await this.slack.testAppToken(trimmed);
        } catch (err) {
          throw new BadRequestException(
            err instanceof Error
              ? err.message
              : "Invalid Slack app-level token"
          );
        }
        data.slackAppToken = trimmed;
      } else {
        data.slackAppToken = null;
      }
      slackTokenChanged = true;
    }
    if (typeof body.allowDirectMerge === "boolean") {
      data.allowDirectMerge = body.allowDirectMerge;
    }
    if (typeof body.debugMode === "boolean") {
      data.debugMode = body.debugMode;
    }
    if (
      typeof body.defaultModel === "string" &&
      (
        ["auto", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"] as string[]
      ).includes(body.defaultModel)
    ) {
      data.defaultModel = body.defaultModel;
    }
    // Tri-state: true=force on, false=force off, null=inherit deployment.
    if (
      body.sandboxBypass === null ||
      typeof body.sandboxBypass === "boolean"
    ) {
      data.sandboxBypass = body.sandboxBypass;
    }

    await this.prisma.client.workspace.update({
      where: { id: workspaceId },
      data,
    });

    // Sync the live Socket Mode connection set with the new DB state. Fire
    // and forget — admins see the save returning "ok" immediately; if the
    // reconnect fails (e.g. Slack rejects the token at connect time despite
    // passing auth.test) the error lands in server logs and we'll surface
    // it via a status badge in a later pass.
    if (slackTokenChanged) {
      this.slackSockets.reconnectWorkspace(workspaceId).catch((err) => {
        this.logger.warn(
          `Slack socket reconnect failed for ${workspaceId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
    }

    return { ok: true };
  }

  async getStorage(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        storageMode: true,
        storageLocalPath: true,
        storageS3Bucket: true,
        storageS3Region: true,
        storageS3AccessKeyId: true,
        storageS3SecretAccessKey: true,
        storageS3Prefix: true,
      },
    });
    return {
      mode: ws?.storageMode ?? "LOCAL",
      localPath: ws?.storageLocalPath ?? null,
      s3: {
        bucket: ws?.storageS3Bucket ?? null,
        region: ws?.storageS3Region ?? null,
        prefix: ws?.storageS3Prefix ?? null,
        accessKeyIdSet: Boolean(ws?.storageS3AccessKeyId),
        secretAccessKeySet: Boolean(ws?.storageS3SecretAccessKey),
      },
    };
  }

  async updateStorage(
    userId: string,
    workspaceId: string,
    body: {
      mode?: "LOCAL" | "S3";
      localPath?: string | null;
      s3Bucket?: string | null;
      s3Region?: string | null;
      s3Prefix?: string | null;
      s3AccessKeyId?: string | null;
      s3SecretAccessKey?: string | null;
    }
  ) {
    await this.access.admin(userId, workspaceId);
    const data: Record<string, unknown> = {};

    if (body.mode === "LOCAL" || body.mode === "S3") {
      data.storageMode = body.mode;
    }
    const trimOrNull = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : null;

    if (body.localPath !== undefined) data.storageLocalPath = trimOrNull(body.localPath);
    if (body.s3Bucket !== undefined) data.storageS3Bucket = trimOrNull(body.s3Bucket);
    if (body.s3Region !== undefined) data.storageS3Region = trimOrNull(body.s3Region);
    if (body.s3Prefix !== undefined) data.storageS3Prefix = trimOrNull(body.s3Prefix);
    if (body.s3AccessKeyId !== undefined)
      data.storageS3AccessKeyId = trimOrNull(body.s3AccessKeyId);
    if (body.s3SecretAccessKey !== undefined)
      data.storageS3SecretAccessKey = trimOrNull(body.s3SecretAccessKey);

    await this.prisma.client.workspace.update({
      where: { id: workspaceId },
      data,
    });
    return { ok: true };
  }

  /**
   * Copy every active env's compose + assets that currently live in the
   * env clone directory into the configured storage backend. Use after
   * switching `storageMode` so existing envs don't lose their files on the
   * next env-clone wipe.
   *
   * Reads from each env's clone dir on the API host; writes through the
   * StorageService (which respects the new mode). Idempotent — re-running
   * just overwrites.
   */
  async migrateEnvsToConfiguredStorage(userId: string, workspaceId: string) {
    await this.access.admin(userId, workspaceId);
    const envs = await this.prisma.client.env.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, composeFile: true, assetFiles: true },
    });

    const results: { envId: string; copied: number; skipped: number; errors: string[] }[] = [];
    for (const env of envs) {
      const r = { envId: env.id, copied: 0, skipped: 0, errors: [] as string[] };
      const envDir = this.envClones.envDir(workspaceId, env.id);
      // Compose: write from DB (source of truth) into storage.
      if (typeof env.composeFile === "string" && env.composeFile.trim()) {
        try {
          await this.storage.writeCompose(workspaceId, env.id, env.composeFile);
          r.copied += 1;
        } catch (err) {
          r.errors.push(`compose: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Assets: read each one from env clone (where they currently live in
      // default-LOCAL mode) and push through storage.
      const meta = Array.isArray(env.assetFiles) ? env.assetFiles : [];
      for (const item of meta) {
        if (!item || typeof item !== "object") continue;
        const p = (item as { path?: unknown }).path;
        if (typeof p !== "string") continue;
        const src = path.join(envDir, "assets", p);
        try {
          const buf = await fs.readFile(src);
          await this.storage.writeAsset(workspaceId, env.id, p, buf);
          r.copied += 1;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            r.skipped += 1;
          } else {
            r.errors.push(
              `${p}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
      results.push(r);
    }
    return { ok: true, envs: results };
  }

  // Round-trips a tiny object through whichever storage the workspace is
  // currently configured for. Returns { ok: true } on success or a structured
  // error so the UI can surface what went wrong.
  async testStorage(userId: string, workspaceId: string) {
    await this.access.admin(userId, workspaceId);
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        storageMode: true,
        storageLocalPath: true,
        storageS3Bucket: true,
        storageS3Region: true,
        storageS3AccessKeyId: true,
        storageS3SecretAccessKey: true,
        storageS3Prefix: true,
      },
    });
    if (!ws) throw new NotFoundException("Workspace not found");

    const probeName = `.withvibe-storage-probe-${Date.now()}.txt`;
    const probeBody = `withvibe ok ${new Date().toISOString()}`;

    if (ws.storageMode === "LOCAL") {
      const base = ws.storageLocalPath?.trim();
      if (!base) {
        throw new BadRequestException("Local path is not set");
      }
      const target = path.join(base, probeName);
      try {
        await fs.mkdir(base, { recursive: true });
        await fs.writeFile(target, probeBody, "utf8");
        const read = await fs.readFile(target, "utf8");
        if (read !== probeBody) throw new Error("Read-back mismatch");
        await fs.unlink(target);
        return { ok: true, mode: "LOCAL" as const, target: base };
      } catch (err) {
        return {
          ok: false,
          mode: "LOCAL" as const,
          target: base,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    // S3
    if (
      !ws.storageS3Bucket ||
      !ws.storageS3Region ||
      !ws.storageS3AccessKeyId ||
      !ws.storageS3SecretAccessKey
    ) {
      throw new BadRequestException(
        "S3 bucket, region, access key, and secret are required"
      );
    }
    const key =
      (ws.storageS3Prefix ? ws.storageS3Prefix.replace(/\/+$/, "") + "/" : "") +
      probeName;
    const client = new S3Client({
      region: ws.storageS3Region,
      credentials: {
        accessKeyId: ws.storageS3AccessKeyId,
        secretAccessKey: ws.storageS3SecretAccessKey,
      },
    });
    try {
      await client.send(
        new PutObjectCommand({
          Bucket: ws.storageS3Bucket,
          Key: key,
          Body: probeBody,
          ContentType: "text/plain",
        })
      );
      const got = await client.send(
        new GetObjectCommand({ Bucket: ws.storageS3Bucket, Key: key })
      );
      const read = (await got.Body?.transformToString()) ?? "";
      if (read !== probeBody) throw new Error("Read-back mismatch");
      await client.send(
        new DeleteObjectCommand({ Bucket: ws.storageS3Bucket, Key: key })
      );
      return {
        ok: true,
        mode: "S3" as const,
        target: `s3://${ws.storageS3Bucket}/${key}`,
      };
    } catch (err) {
      return {
        ok: false,
        mode: "S3" as const,
        target: `s3://${ws.storageS3Bucket}/${key}`,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      client.destroy();
    }
  }
}
