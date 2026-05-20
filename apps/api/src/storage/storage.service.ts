import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { ensureEnvDir } from "../common/repo-base-dir";
import { PrismaService } from "../prisma/prisma.service";
import { EnvCloneService } from "../env-clones/env-clone.service";

type WorkspaceStorage = {
  storageMode: "LOCAL" | "S3";
  storageLocalPath: string | null;
  storageS3Bucket: string | null;
  storageS3Region: string | null;
  storageS3AccessKeyId: string | null;
  storageS3SecretAccessKey: string | null;
  storageS3Prefix: string | null;
};

/**
 * Single source of truth for compose files and env assets.
 *
 * The bind-mount target is always the env clone directory (`envDir`) — Docker
 * needs real local files. Storage modes differ in where the *durable* copy
 * lives:
 *
 *   LOCAL (no custom path)  storageBase === envDir; writes are direct
 *   LOCAL (custom path)     storageBase elsewhere; sync copies → envDir
 *   S3                      durable in bucket; sync downloads → envDir
 *
 * Callers should:
 *   • use `writeAsset`/`writeCompose`/`deleteAsset` for state changes
 *   • call `syncToEnvClone(envId)` before reading files from envDir
 *     (DockerService does this before `docker compose up`)
 */
@Injectable()
export class StorageService {
  private readonly s3Clients = new Map<string, S3Client>();

  constructor(
    @InjectPinoLogger(StorageService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly envClones: EnvCloneService
  ) {}

  // ---------- public API --------------------------------------------------

  /** Write a file at any path under the env's storage root. */
  async writeFile(
    workspaceId: string,
    envId: string,
    relPath: string,
    body: Buffer | string
  ): Promise<void> {
    await this.write(workspaceId, envId, this.normalizeKey(relPath), body);
  }

  /** Read a file at any path under the env's storage root. */
  async readFile(
    workspaceId: string,
    envId: string,
    relPath: string
  ): Promise<Buffer> {
    return this.read(workspaceId, envId, this.normalizeKey(relPath));
  }

  /** Delete a single file at any path under the env's storage root. Idempotent. */
  async deleteFile(
    workspaceId: string,
    envId: string,
    relPath: string
  ): Promise<void> {
    await this.delete(workspaceId, envId, this.normalizeKey(relPath));
  }

  async writeAsset(
    workspaceId: string,
    envId: string,
    relPath: string,
    body: Buffer | string
  ): Promise<void> {
    await this.writeFile(workspaceId, envId, this.assetKey(relPath), body);
  }

  async readAsset(
    workspaceId: string,
    envId: string,
    relPath: string
  ): Promise<Buffer> {
    return this.readFile(workspaceId, envId, this.assetKey(relPath));
  }

  async deleteAsset(
    workspaceId: string,
    envId: string,
    relPath: string
  ): Promise<void> {
    await this.deleteFile(workspaceId, envId, this.assetKey(relPath));
  }

  async writeContext(
    workspaceId: string,
    envId: string,
    attachmentName: string,
    relPath: string,
    body: Buffer | string
  ): Promise<void> {
    await this.writeFile(
      workspaceId,
      envId,
      this.contextKey(attachmentName, relPath),
      body
    );
  }

  async deleteContextFile(
    workspaceId: string,
    envId: string,
    attachmentName: string,
    relPath: string
  ): Promise<void> {
    await this.deleteFile(
      workspaceId,
      envId,
      this.contextKey(attachmentName, relPath)
    );
  }

  /**
   * Write a file anywhere under the env's `extracontext/` tree. `relPath` is
   * the path from inside extracontext/ (e.g. "ai/docs/foo.md" or
   * "research/papers/2024.pdf"). Used by the filesystem-tree REST endpoints
   * and by AI-side helpers that drop deliverables into extracontext/ai/.
   */
  async writeExtraContextFile(
    workspaceId: string,
    envId: string,
    relPath: string,
    body: Buffer | string
  ): Promise<void> {
    const clean = relPath.replace(/^\/+/, "");
    await this.writeFile(workspaceId, envId, `extracontext/${clean}`, body);
  }

  /** Delete a single file or directory anywhere under `extracontext/`. */
  async deleteExtraContextEntry(
    workspaceId: string,
    envId: string,
    relPath: string
  ): Promise<void> {
    const cfg = await this.loadConfig(workspaceId);
    const clean = relPath.replace(/^\/+|\/+$/g, "");
    if (clean.length === 0) {
      throw new Error("Refusing to delete extracontext root");
    }
    const subPath = `extracontext/${clean}`;
    if (cfg.storageMode === "LOCAL") {
      const base = this.localEnvBase(workspaceId, envId, cfg);
      await fs.rm(path.join(base, subPath), { recursive: true, force: true });
      return;
    }
    const client = this.s3Client(workspaceId, cfg);
    // Try as a single object first (file case), then list-and-delete with the
    // dir prefix to cover the folder case.
    const single = this.s3EnvPrefix(workspaceId, envId, cfg) + subPath;
    await client
      .send(
        new DeleteObjectsCommand({
          Bucket: cfg.storageS3Bucket!,
          Delete: { Objects: [{ Key: single }] },
        })
      )
      .catch(() => {});
    const dirPrefix =
      this.s3EnvPrefix(workspaceId, envId, cfg) + `${subPath}/`;
    let token: string | undefined;
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.storageS3Bucket!,
          Prefix: dirPrefix,
          ContinuationToken: token,
        })
      );
      const keys = (out.Contents ?? [])
        .map((c) => c.Key)
        .filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: cfg.storageS3Bucket!,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          })
        );
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  /** Drop every file under a single context attachment. Idempotent. */
  async deleteContextAttachment(
    workspaceId: string,
    envId: string,
    attachmentName: string
  ): Promise<void> {
    const cfg = await this.loadConfig(workspaceId);
    const subPath = `extracontext/${attachmentName}`;
    if (cfg.storageMode === "LOCAL") {
      const base = this.localEnvBase(workspaceId, envId, cfg);
      await fs.rm(path.join(base, subPath), { recursive: true, force: true });
      return;
    }
    const client = this.s3Client(workspaceId, cfg);
    const prefix = this.s3EnvPrefix(workspaceId, envId, cfg) + `${subPath}/`;
    let token: string | undefined;
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.storageS3Bucket!,
          Prefix: prefix,
          ContinuationToken: token,
        })
      );
      const keys = (out.Contents ?? [])
        .map((c) => c.Key)
        .filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: cfg.storageS3Bucket!,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          })
        );
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  async writeCompose(
    workspaceId: string,
    envId: string,
    content: string
  ): Promise<void> {
    await this.writeFile(workspaceId, envId, this.composeKey(envId), content);
  }

  async deleteCompose(workspaceId: string, envId: string): Promise<void> {
    await this.deleteFile(workspaceId, envId, this.composeKey(envId));
  }

  // ---------- template-scoped storage -------------------------------------

  async writeTemplateFile(
    workspaceId: string,
    templateId: string,
    relPath: string,
    body: Buffer | string
  ): Promise<void> {
    await this.writeNamespaced(
      workspaceId,
      this.templateNamespace(templateId),
      this.normalizeKey(relPath),
      body
    );
  }

  async deleteTemplateFile(
    workspaceId: string,
    templateId: string,
    relPath: string
  ): Promise<void> {
    await this.deleteNamespaced(
      workspaceId,
      this.templateNamespace(templateId),
      this.normalizeKey(relPath)
    );
  }

  /** Drop every file under a template's storage prefix. Idempotent. */
  async deleteTemplate(workspaceId: string, templateId: string): Promise<void> {
    const cfg = await this.loadConfig(workspaceId);
    if (cfg.storageMode === "LOCAL") {
      const base = this.localNamespaceBase(
        workspaceId,
        this.templateNamespace(templateId),
        cfg
      );
      await fs.rm(base, { recursive: true, force: true });
      return;
    }
    const client = this.s3Client(workspaceId, cfg);
    const prefix = this.s3NamespacePrefix(
      workspaceId,
      this.templateNamespace(templateId),
      cfg
    );
    let token: string | undefined;
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.storageS3Bucket!,
          Prefix: prefix,
          ContinuationToken: token,
        })
      );
      const keys = (out.Contents ?? [])
        .map((c) => c.Key)
        .filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: cfg.storageS3Bucket!,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          })
        );
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  private templateNamespace(templateId: string): string {
    // Templates live alongside envs but in a sibling tree so prefixes don't
    // collide. Format: `<wsid>/templates/<templateId>/...`
    return `templates/${templateId}`;
  }

  private normalizeKey(relPath: string): string {
    return relPath.replace(/^\/+/, "").replace(/\\/g, "/");
  }

  /** Path under envDir where the custom compose lands after sync. */
  composeEnvClonePath(envId: string, envDir: string): string {
    return path.join(envDir, this.composeKey(envId));
  }

  /**
   * Materialize the env's durable storage into the env clone directory so
   * Docker can bind-mount. No-op when storage IS the env clone dir.
   */
  async syncToEnvClone(workspaceId: string, envId: string): Promise<void> {
    const cfg = await this.loadConfig(workspaceId);
    const envDir = this.envClones.envDir(workspaceId, envId);

    if (cfg.storageMode === "LOCAL") {
      const base = this.localEnvBase(workspaceId, envId, cfg);
      if (path.resolve(base) === path.resolve(envDir)) return;
      await this.copyDirIfExists(base, envDir);
      return;
    }

    // S3 — download every object under the env prefix into envDir.
    const client = this.s3Client(workspaceId, cfg);
    const prefix = this.s3EnvPrefix(workspaceId, envId, cfg);
    let token: string | undefined;
    await ensureEnvDir(envDir);
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.storageS3Bucket!,
          Prefix: prefix,
          ContinuationToken: token,
        })
      );
      for (const obj of out.Contents ?? []) {
        if (!obj.Key) continue;
        const rel = obj.Key.slice(prefix.length);
        if (!rel) continue;
        const dest = path.join(envDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const got = await client.send(
          new GetObjectCommand({ Bucket: cfg.storageS3Bucket!, Key: obj.Key })
        );
        const bytes = await got.Body?.transformToByteArray();
        if (bytes) await fs.writeFile(dest, Buffer.from(bytes));
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  /** Drop the entire env's durable storage. Idempotent. */
  async deleteEnv(workspaceId: string, envId: string): Promise<void> {
    const cfg = await this.loadConfig(workspaceId);
    if (cfg.storageMode === "LOCAL") {
      const base = this.localEnvBase(workspaceId, envId, cfg);
      const envDir = this.envClones.envDir(workspaceId, envId);
      // When storage is the env clone dir, env-clone teardown already cleans this.
      if (path.resolve(base) === path.resolve(envDir)) return;
      await fs.rm(base, { recursive: true, force: true });
      return;
    }
    const client = this.s3Client(workspaceId, cfg);
    const prefix = this.s3EnvPrefix(workspaceId, envId, cfg);
    let token: string | undefined;
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.storageS3Bucket!,
          Prefix: prefix,
          ContinuationToken: token,
        })
      );
      const keys = (out.Contents ?? [])
        .map((c) => c.Key)
        .filter((k): k is string => Boolean(k));
      if (keys.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: cfg.storageS3Bucket!,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          })
        );
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
  }

  // ---------- internals ---------------------------------------------------

  private assetKey(relPath: string): string {
    // assets are namespaced under "assets/" in storage; matches the on-disk
    // layout DockerService inspects under envDir.
    const clean = relPath.replace(/^\/+/, "");
    return `assets/${clean}`;
  }

  private contextKey(attachmentName: string, relPath: string): string {
    const clean = relPath.replace(/^\/+/, "");
    return `extracontext/${attachmentName}/${clean}`;
  }

  private composeKey(envId: string): string {
    return `.withvibe-${envId}-compose.yml`;
  }

  private async loadConfig(workspaceId: string): Promise<WorkspaceStorage> {
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
    return ws as WorkspaceStorage;
  }

  private localEnvBase(
    workspaceId: string,
    envId: string,
    cfg: WorkspaceStorage
  ): string {
    if (cfg.storageLocalPath && cfg.storageLocalPath.trim()) {
      return path.join(cfg.storageLocalPath, workspaceId, envId);
    }
    return this.envClones.envDir(workspaceId, envId);
  }

  private s3EnvPrefix(
    workspaceId: string,
    envId: string,
    cfg: WorkspaceStorage
  ): string {
    const root = cfg.storageS3Prefix
      ? cfg.storageS3Prefix.replace(/^\/+|\/+$/g, "") + "/"
      : "";
    return `${root}${workspaceId}/${envId}/`;
  }

  private s3Client(workspaceId: string, cfg: WorkspaceStorage): S3Client {
    if (
      !cfg.storageS3Bucket ||
      !cfg.storageS3Region ||
      !cfg.storageS3AccessKeyId ||
      !cfg.storageS3SecretAccessKey
    ) {
      throw new Error(
        `Workspace ${workspaceId} is in S3 mode but credentials are incomplete`
      );
    }
    const cacheKey = `${workspaceId}:${cfg.storageS3Region}:${cfg.storageS3AccessKeyId}`;
    let client = this.s3Clients.get(cacheKey);
    if (!client) {
      client = new S3Client({
        region: cfg.storageS3Region,
        credentials: {
          accessKeyId: cfg.storageS3AccessKeyId,
          secretAccessKey: cfg.storageS3SecretAccessKey,
        },
      });
      this.s3Clients.set(cacheKey, client);
    }
    return client;
  }

  private async write(
    workspaceId: string,
    envId: string,
    key: string,
    body: Buffer | string
  ): Promise<void> {
    return this.writeNamespaced(workspaceId, envId, key, body);
  }

  private async read(
    workspaceId: string,
    envId: string,
    key: string
  ): Promise<Buffer> {
    const cfg = await this.loadConfig(workspaceId);
    if (cfg.storageMode === "LOCAL") {
      const base = this.localNamespaceBase(workspaceId, envId, cfg);
      return fs.readFile(path.join(base, key));
    }
    const client = this.s3Client(workspaceId, cfg);
    const out = await client.send(
      new GetObjectCommand({
        Bucket: cfg.storageS3Bucket!,
        Key: this.s3NamespacePrefix(workspaceId, envId, cfg) + key,
      })
    );
    const bytes = await out.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Empty body for ${key}`);
    return Buffer.from(bytes);
  }

  private async delete(
    workspaceId: string,
    envId: string,
    key: string
  ): Promise<void> {
    return this.deleteNamespaced(workspaceId, envId, key);
  }

  private async writeNamespaced(
    workspaceId: string,
    namespace: string,
    key: string,
    body: Buffer | string
  ): Promise<void> {
    const cfg = await this.loadConfig(workspaceId);
    if (cfg.storageMode === "LOCAL") {
      const base = this.localNamespaceBase(workspaceId, namespace, cfg);
      const target = path.join(base, key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
      return;
    }
    const client = this.s3Client(workspaceId, cfg);
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.storageS3Bucket!,
        Key: this.s3NamespacePrefix(workspaceId, namespace, cfg) + key,
        Body: body,
      })
    );
  }

  private async deleteNamespaced(
    workspaceId: string,
    namespace: string,
    key: string
  ): Promise<void> {
    const cfg = await this.loadConfig(workspaceId);
    if (cfg.storageMode === "LOCAL") {
      const base = this.localNamespaceBase(workspaceId, namespace, cfg);
      await fs.rm(path.join(base, key), { force: true });
      return;
    }
    const client = this.s3Client(workspaceId, cfg);
    await client.send(
      new DeleteObjectCommand({
        Bucket: cfg.storageS3Bucket!,
        Key: this.s3NamespacePrefix(workspaceId, namespace, cfg) + key,
      })
    );
  }

  private localNamespaceBase(
    workspaceId: string,
    namespace: string,
    cfg: WorkspaceStorage
  ): string {
    if (namespace.startsWith("templates/")) {
      // Templates always live in storageLocalPath (or env-clone base) under a
      // dedicated templates/<templateId> tree — never inside an env clone dir.
      const root = cfg.storageLocalPath?.trim()
        ? cfg.storageLocalPath
        : path.dirname(this.envClones.envDir(workspaceId, "_"));
      return path.join(root, workspaceId, namespace);
    }
    // Env namespace (`namespace` is an envId).
    return this.localEnvBase(workspaceId, namespace, cfg);
  }

  private s3NamespacePrefix(
    workspaceId: string,
    namespace: string,
    cfg: WorkspaceStorage
  ): string {
    const root = cfg.storageS3Prefix
      ? cfg.storageS3Prefix.replace(/^\/+|\/+$/g, "") + "/"
      : "";
    return `${root}${workspaceId}/${namespace}/`;
  }

  private async copyDirIfExists(src: string, dst: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(src, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    await fs.mkdir(dst, { recursive: true });
    for (const e of entries) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) {
        await this.copyDirIfExists(s, d);
      } else if (e.isFile()) {
        await fs.copyFile(s, d);
      }
    }
  }
}
