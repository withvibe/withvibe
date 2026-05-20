import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { StorageService } from "../storage/storage.service";
import {
  TemplateService as TemplateServiceSpec,
  TemplateVariable,
  normalizeTemplateAssetPath,
  normalizeTemplateSlug,
  parseTemplateServices,
  parseTemplateVariables,
} from "./template.types";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

type AssetInput = { path: string; content: string; isTemplate?: boolean };
type RepoInput = { id: string; baseBranch: string | null };

type UpsertBody = {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  composeFile?: unknown;
  variables?: unknown;
  assets?: unknown;
  repos?: unknown;
  routingMode?: unknown;
  routingBaseDomain?: unknown;
  qaBrowserMode?: unknown;
  agentInstructions?: unknown;
  services?: unknown;
};

@Injectable()
export class TemplatesService {
  constructor(
    @InjectPinoLogger(TemplatesService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly storage: StorageService
  ) {}

  /**
   * Mirror a template's compose + assets into the workspace's configured
   * storage (S3 or local). Failures are logged, never fatal — DB is the
   * source of truth. The mirror is for visibility / out-of-band use, not
   * read-back during materialization.
   */
  private async mirrorTemplateToStorage(
    workspaceId: string,
    templateId: string,
    args: {
      composeFile?: string | null;
      assets?: AssetInput[] | null;
    }
  ): Promise<void> {
    try {
      // Drop the prior tree first so removed assets don't linger.
      await this.storage.deleteTemplate(workspaceId, templateId);
      if (args.composeFile && args.composeFile.trim()) {
        await this.storage.writeTemplateFile(
          workspaceId,
          templateId,
          "docker-compose.yml",
          args.composeFile
        );
      }
      for (const a of args.assets ?? []) {
        await this.storage.writeTemplateFile(
          workspaceId,
          templateId,
          a.path,
          a.content
        );
      }
    } catch (err) {
      this.logger.error(
        `Template ${templateId} storage mirror failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  async list(userId: string, workspaceId: string) {
    await this.access.member(userId, workspaceId);
    const rows = await this.prisma.client.envTemplate.findMany({
      where: { workspaceId },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        variables: true,
        routingMode: true,
        routingBaseDomain: true,
        qaBrowserMode: true,
        createdAt: true,
        updatedAt: true,
        repos: {
          select: {
            repoId: true,
            baseBranch: true,
            repo: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
    return rows;
  }

  async detail(userId: string, workspaceId: string, templateId: string) {
    await this.access.member(userId, workspaceId);
    const tpl = await this.prisma.client.envTemplate.findUnique({
      where: { id: templateId },
      include: {
        assets: {
          select: {
            id: true,
            path: true,
            content: true,
            isTemplate: true,
            updatedAt: true,
          },
          orderBy: { path: "asc" },
        },
        repos: {
          select: {
            repoId: true,
            baseBranch: true,
            repo: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!tpl || tpl.workspaceId !== workspaceId) {
      throw new NotFoundException("Template not found");
    }
    return tpl;
  }

  async create(userId: string, workspaceId: string, body: UpsertBody) {
    // Only admins may author templates — they ship secrets and infra assumptions.
    await this.access.admin(userId, workspaceId);

    const {
      slug,
      name,
      description,
      composeFile,
      variables,
      assets,
      repos,
      routingMode,
      routingBaseDomain,
      qaBrowserMode,
      agentInstructions,
      services,
    } = this.parseBody(body, { requireAll: true });

    const existing = await this.prisma.client.envTemplate.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: slug! } },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(`Template slug "${slug}" already exists`);
    }

    if (repos && repos.length > 0) {
      await this.assertReposInWorkspace(workspaceId, repos);
    }

    const tpl = await this.prisma.client.envTemplate.create({
      data: {
        workspaceId,
        slug: slug!,
        name: name!,
        description,
        composeFile: composeFile!,
        variables: variables as unknown as object,
        routingMode: routingMode ?? "port",
        routingBaseDomain: routingBaseDomain ?? null,
        qaBrowserMode: qaBrowserMode ?? "sidecar",
        agentInstructions: agentInstructions ?? null,
        services: (services ?? []) as unknown as object,
        assets: {
          create: (assets ?? []).map((a) => ({
            path: a.path,
            content: a.content,
            isTemplate: a.isTemplate ?? false,
          })),
        },
        repos: {
          create: (repos ?? []).map((r) => ({
            repoId: r.id,
            baseBranch: r.baseBranch,
          })),
        },
      },
      select: { id: true },
    });
    this.logger.info(
      `Template created: ${tpl.id} (slug=${slug}, workspace=${workspaceId})`
    );
    await this.mirrorTemplateToStorage(workspaceId, tpl.id, {
      composeFile: composeFile!,
      assets: assets ?? [],
    });
    return tpl;
  }

  async update(
    userId: string,
    workspaceId: string,
    templateId: string,
    body: UpsertBody
  ) {
    await this.access.admin(userId, workspaceId);
    const existing = await this.prisma.client.envTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, workspaceId: true, slug: true },
    });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new NotFoundException("Template not found");
    }
    const parsed = this.parseBody(body, { requireAll: false });

    if (parsed.slug !== undefined && parsed.slug !== existing.slug) {
      const clash = await this.prisma.client.envTemplate.findUnique({
        where: { workspaceId_slug: { workspaceId, slug: parsed.slug } },
        select: { id: true },
      });
      if (clash) throw new BadRequestException(`Slug "${parsed.slug}" already exists`);
    }

    if (parsed.repos && parsed.repos.length > 0) {
      await this.assertReposInWorkspace(workspaceId, parsed.repos);
    }

    await this.prisma.client.$transaction(async (tx) => {
      const data: Record<string, unknown> = {};
      if (parsed.slug !== undefined) data.slug = parsed.slug;
      if (parsed.name !== undefined) data.name = parsed.name;
      if (parsed.description !== undefined) data.description = parsed.description;
      if (parsed.composeFile !== undefined) data.composeFile = parsed.composeFile;
      if (parsed.variables !== undefined) data.variables = parsed.variables;
      if (parsed.routingMode !== undefined) data.routingMode = parsed.routingMode;
      if (parsed.routingBaseDomain !== undefined) data.routingBaseDomain = parsed.routingBaseDomain;
      if (parsed.qaBrowserMode !== undefined) data.qaBrowserMode = parsed.qaBrowserMode;
      if (parsed.agentInstructions !== undefined) data.agentInstructions = parsed.agentInstructions;
      if (parsed.services !== undefined) data.services = parsed.services;
      if (Object.keys(data).length > 0) {
        await tx.envTemplate.update({ where: { id: templateId }, data });
      }
      // Simple strategy: if assets provided, replace the whole set. Templates
      // are small and editing through this API is an admin-only batch op.
      if (parsed.assets !== undefined) {
        await tx.envTemplateAsset.deleteMany({ where: { templateId } });
        if (parsed.assets.length > 0) {
          await tx.envTemplateAsset.createMany({
            data: parsed.assets.map((a) => ({
              templateId,
              path: a.path,
              content: a.content,
              isTemplate: a.isTemplate ?? false,
            })),
          });
        }
      }
      if (parsed.repos !== undefined) {
        await tx.envTemplateRepo.deleteMany({ where: { templateId } });
        if (parsed.repos.length > 0) {
          await tx.envTemplateRepo.createMany({
            data: parsed.repos.map((r) => ({
              templateId,
              repoId: r.id,
              baseBranch: r.baseBranch,
            })),
          });
        }
      }
    });

    // Mirror after the txn commits — storage writes shouldn't take part in
    // the DB transaction. Re-read the canonical state to avoid drift if the
    // request only touched a subset of fields.
    if (parsed.composeFile !== undefined || parsed.assets !== undefined) {
      const fresh = await this.prisma.client.envTemplate.findUnique({
        where: { id: templateId },
        select: {
          composeFile: true,
          assets: { select: { path: true, content: true, isTemplate: true } },
        },
      });
      if (fresh) {
        await this.mirrorTemplateToStorage(workspaceId, templateId, {
          composeFile: fresh.composeFile,
          assets: fresh.assets.map((a) => ({
            path: a.path,
            content: a.content,
            isTemplate: a.isTemplate,
          })),
        });
      }
    }
    return { ok: true };
  }

  private async assertReposInWorkspace(
    workspaceId: string,
    repos: RepoInput[]
  ) {
    const ids = repos.map((r) => r.id);
    const found = await this.prisma.client.repo.findMany({
      where: { workspaceId, id: { in: ids } },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException("One or more repos not found in workspace");
    }
  }

  async delete(userId: string, workspaceId: string, templateId: string) {
    await this.access.admin(userId, workspaceId);
    const existing = await this.prisma.client.envTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, workspaceId: true },
    });
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new NotFoundException("Template not found");
    }
    await this.prisma.client.envTemplate.delete({ where: { id: templateId } });
    await this.storage
      .deleteTemplate(workspaceId, templateId)
      .catch((err) =>
        this.logger.error(
          `Failed to drop template ${templateId} from storage: ${err}`
        )
      );
    return { ok: true };
  }

  private parseBody(
    body: UpsertBody,
    opts: { requireAll: boolean }
  ): {
    slug?: string;
    name?: string;
    description?: string | null;
    composeFile?: string;
    variables?: TemplateVariable[];
    assets?: AssetInput[];
    repos?: RepoInput[];
    routingMode?: "port" | "subdomain";
    routingBaseDomain?: string | null;
    qaBrowserMode?: "sidecar" | "user_browser";
    agentInstructions?: string | null;
    services?: TemplateServiceSpec[];
  } {
    const out: {
      slug?: string;
      name?: string;
      description?: string | null;
      composeFile?: string;
      variables?: TemplateVariable[];
      assets?: AssetInput[];
      repos?: RepoInput[];
      routingMode?: "port" | "subdomain";
      routingBaseDomain?: string | null;
      qaBrowserMode?: "sidecar" | "user_browser";
      agentInstructions?: string | null;
      services?: TemplateServiceSpec[];
    } = {};

    if (body.slug !== undefined) {
      out.slug = normalizeTemplateSlug(body.slug);
    } else if (opts.requireAll) {
      throw new BadRequestException("slug is required");
    }

    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw new BadRequestException("name is required");
      }
      out.name = body.name.trim();
    } else if (opts.requireAll) {
      throw new BadRequestException("name is required");
    }

    if (body.description !== undefined) {
      if (body.description === null) out.description = null;
      else if (typeof body.description !== "string") {
        throw new BadRequestException("description must be a string or null");
      } else {
        out.description = body.description.trim() || null;
      }
    }

    // composeFile may be empty when the template attaches one or more repos
    // and the env should use the repo's own docker-compose.yml. The
    // materializer enforces "exactly one repo with a compose file at root"
    // when this is the case — keep validation here permissive.
    if (body.composeFile !== undefined) {
      if (typeof body.composeFile !== "string") {
        throw new BadRequestException("composeFile must be a string");
      }
      out.composeFile = body.composeFile;
    } else if (opts.requireAll) {
      out.composeFile = "";
    }

    if (body.variables !== undefined) {
      out.variables = parseTemplateVariables(body.variables);
    } else if (opts.requireAll) {
      out.variables = [];
    }

    if (body.assets !== undefined) {
      if (!Array.isArray(body.assets)) {
        throw new BadRequestException("assets must be an array");
      }
      const assets: AssetInput[] = [];
      const seenPaths = new Set<string>();
      for (const [i, a] of body.assets.entries()) {
        if (!a || typeof a !== "object") {
          throw new BadRequestException(`assets[${i}] must be an object`);
        }
        const row = a as Record<string, unknown>;
        const p = normalizeTemplateAssetPath(row.path);
        if (seenPaths.has(p)) {
          throw new BadRequestException(`Duplicate asset path "${p}"`);
        }
        seenPaths.add(p);
        if (typeof row.content !== "string") {
          throw new BadRequestException(`assets[${i}].content must be a string`);
        }
        const isTemplate =
          typeof row.isTemplate === "boolean" ? row.isTemplate : false;
        assets.push({ path: p, content: row.content, isTemplate });
      }
      out.assets = assets;
    }

    if (body.repos !== undefined) {
      if (!Array.isArray(body.repos)) {
        throw new BadRequestException("repos must be an array");
      }
      const repos: RepoInput[] = [];
      const seenIds = new Set<string>();
      for (const [i, r] of body.repos.entries()) {
        if (!r || typeof r !== "object") {
          throw new BadRequestException(`repos[${i}] must be an object`);
        }
        const row = r as Record<string, unknown>;
        if (typeof row.id !== "string" || !row.id.trim()) {
          throw new BadRequestException(`repos[${i}].id is required`);
        }
        const id = row.id.trim();
        if (seenIds.has(id)) {
          throw new BadRequestException(`Duplicate repo id "${id}"`);
        }
        seenIds.add(id);
        let baseBranch: string | null = null;
        if (row.baseBranch !== undefined && row.baseBranch !== null) {
          if (typeof row.baseBranch !== "string") {
            throw new BadRequestException(
              `repos[${i}].baseBranch must be a string or null`
            );
          }
          baseBranch = row.baseBranch.trim() || null;
        }
        repos.push({ id, baseBranch });
      }
      out.repos = repos;
    }

    if (body.routingMode !== undefined) {
      if (body.routingMode !== "port" && body.routingMode !== "subdomain") {
        throw new BadRequestException("routingMode must be 'port' or 'subdomain'");
      }
      out.routingMode = body.routingMode;
    }

    if (body.routingBaseDomain !== undefined) {
      if (body.routingBaseDomain === null) {
        out.routingBaseDomain = null;
      } else if (typeof body.routingBaseDomain !== "string") {
        throw new BadRequestException("routingBaseDomain must be a string or null");
      } else {
        out.routingBaseDomain = body.routingBaseDomain.trim() || null;
      }
    }

    // If subdomain mode is set without an explicit base domain, default to
    // "localhost" so the common dev-on-laptop path works without a second save.
    if (out.routingMode === "subdomain" && out.routingBaseDomain === undefined) {
      out.routingBaseDomain = "localhost";
    }

    if (body.qaBrowserMode !== undefined) {
      if (
        body.qaBrowserMode !== "sidecar" &&
        body.qaBrowserMode !== "user_browser"
      ) {
        throw new BadRequestException(
          "qaBrowserMode must be 'sidecar' or 'user_browser'"
        );
      }
      out.qaBrowserMode = body.qaBrowserMode;
    }

    if (body.agentInstructions !== undefined) {
      if (body.agentInstructions === null) out.agentInstructions = null;
      else if (typeof body.agentInstructions !== "string") {
        throw new BadRequestException(
          "agentInstructions must be a string or null"
        );
      } else {
        out.agentInstructions = body.agentInstructions.trim() || null;
      }
    }

    if (body.services !== undefined) {
      out.services = parseTemplateServices(body.services);
    }

    return out;
  }
}
