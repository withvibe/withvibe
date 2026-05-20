import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@withvibe/db";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { AgentSeedService } from "../agents/agent-seed.service";
import { StorageService } from "../storage/storage.service";
import {
  MAX_ENV_ASSETS_TOTAL_BYTES,
  MAX_ENV_ASSET_FILES,
  MAX_ENV_ASSET_FILE_BYTES,
  normalizeAssetPath,
  type EnvAssetMeta,
} from "./envs.service";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

type UploadedFile = {
  /** Relative path (from webkitdirectory-style uploads) — validated. */
  relativePath: string;
  buffer: Buffer;
};

@Injectable()
export class EnvAssetsService {
  constructor(
    @InjectPinoLogger(EnvAssetsService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly agentSeed: AgentSeedService,
    private readonly storage: StorageService
  ) {}

  private async loadEnv(
    userId: string,
    workspaceId: string,
    envId: string
  ): Promise<{ assetFiles: EnvAssetMeta[] }> {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true, assetFiles: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
    return {
      assetFiles: this.readMeta(env.assetFiles),
    };
  }

  async list(
    userId: string,
    workspaceId: string,
    envId: string
  ): Promise<EnvAssetMeta[]> {
    const { assetFiles } = await this.loadEnv(userId, workspaceId, envId);
    return assetFiles;
  }

  async upload(
    userId: string,
    workspaceId: string,
    envId: string,
    files: UploadedFile[]
  ): Promise<EnvAssetMeta[]> {
    this.logger.info(
      `Asset upload: env ${envId}, ${files.length} file(s): ${files.map((f) => f.relativePath).join(", ")}`
    );
    const { assetFiles } = await this.loadEnv(userId, workspaceId, envId);
    if (files.length === 0) {
      throw new BadRequestException("No files uploaded");
    }

    const existingByPath = new Map(assetFiles.map((a) => [a.path, a]));
    const incoming: EnvAssetMeta[] = [];
    let totalBytes = assetFiles.reduce((s, a) => s + a.size, 0);

    // First pass: validate all — reject the whole batch on any failure so we
    // don't leave partial state behind.
    const normalized: { path: string; buffer: Buffer }[] = [];
    for (const f of files) {
      if (f.buffer.byteLength > MAX_ENV_ASSET_FILE_BYTES) {
        throw new BadRequestException(
          `"${f.relativePath}" exceeds ${MAX_ENV_ASSET_FILE_BYTES / 1024 / 1024}MB per-file limit`
        );
      }
      const normalizedPath = normalizeAssetPath(f.relativePath);
      normalized.push({ path: normalizedPath, buffer: f.buffer });
    }

    const mergedPaths = new Set(assetFiles.map((a) => a.path));
    for (const n of normalized) {
      if (!existingByPath.has(n.path)) {
        mergedPaths.add(n.path);
        totalBytes += n.buffer.byteLength;
      } else {
        totalBytes =
          totalBytes - (existingByPath.get(n.path)?.size ?? 0) + n.buffer.byteLength;
      }
    }
    if (mergedPaths.size > MAX_ENV_ASSET_FILES) {
      throw new BadRequestException(
        `Too many asset files — limit ${MAX_ENV_ASSET_FILES}`
      );
    }
    if (totalBytes > MAX_ENV_ASSETS_TOTAL_BYTES) {
      throw new BadRequestException(
        `Total asset size would exceed ${MAX_ENV_ASSETS_TOTAL_BYTES / 1024 / 1024}MB`
      );
    }

    // Write to durable storage (LOCAL fs or S3 — handled by StorageService).
    for (const n of normalized) {
      await this.storage.writeAsset(workspaceId, envId, n.path, n.buffer);
      incoming.push({
        path: n.path,
        size: n.buffer.byteLength,
        updatedAt: new Date().toISOString(),
      });
    }

    // Merge metadata: incoming wins on same path, others preserved.
    const incomingByPath = new Map(incoming.map((a) => [a.path, a]));
    const merged: EnvAssetMeta[] = [];
    for (const a of assetFiles) {
      merged.push(incomingByPath.get(a.path) ?? a);
      incomingByPath.delete(a.path);
    }
    for (const a of incomingByPath.values()) merged.push(a);
    merged.sort((a, b) => a.path.localeCompare(b.path));

    await this.prisma.client.env.update({
      where: { id: envId },
      data: { assetFiles: merged.length > 0 ? merged : Prisma.DbNull },
    });

    this.logger.info(
      `Env ${envId} assets: uploaded ${incoming.length} file(s), total ${merged.length}`
    );
    await this.agentSeed
      .refreshDevOpsGreetingIfUnused(envId)
      .catch((err) =>
        this.logger.error(`Failed to refresh greeting for env ${envId}: ${err}`)
      );
    return merged;
  }

  async delete(
    userId: string,
    workspaceId: string,
    envId: string,
    rawPath: string
  ): Promise<EnvAssetMeta[]> {
    const { assetFiles } = await this.loadEnv(userId, workspaceId, envId);
    const target = normalizeAssetPath(rawPath);
    const next = assetFiles.filter((a) => a.path !== target);
    if (next.length === assetFiles.length) {
      throw new NotFoundException(`Asset not found: "${target}"`);
    }

    await this.storage.deleteAsset(workspaceId, envId, target);

    await this.prisma.client.env.update({
      where: { id: envId },
      data: { assetFiles: next.length > 0 ? next : Prisma.DbNull },
    });
    await this.agentSeed
      .refreshDevOpsGreetingIfUnused(envId)
      .catch((err) =>
        this.logger.error(`Failed to refresh greeting for env ${envId}: ${err}`)
      );
    return next;
  }

  /** Re-materialize all assets on disk if the envDir was cleared (e.g. tmp wipe). */
  async rematerialize(
    workspaceId: string,
    envId: string
  ): Promise<void> {
    await this.storage.syncToEnvClone(workspaceId, envId);
  }

  private readMeta(raw: unknown): EnvAssetMeta[] {
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
