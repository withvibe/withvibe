import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import * as fs from "fs/promises";
import { type Dirent } from "fs";
import * as path from "node:path";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { StorageService } from "../storage/storage.service";
import { CodeWorkspaceService } from "../env-clones/code-workspace.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import {
  MAX_ENV_CONTEXT_FILES,
  MAX_ENV_CONTEXT_FILE_BYTES,
  MAX_ENV_CONTEXT_TOTAL_BYTES,
  normalizeContextRelPath,
} from "./env-context-types";

export type EnvContextTreeEntry = {
  name: string;
  /** POSIX relative path from `extracontext/` (empty string means the root). */
  path: string;
  kind: "file" | "folder";
  size: number;
  modifiedAt: string;
  children?: EnvContextTreeEntry[];
};

export type UploadedFile = {
  /** Path inside `extracontext/` where this file should land — typically
   *  `<destDir>/<basename>`. */
  relPath: string;
  buffer: Buffer;
};

/**
 * Filesystem-tree backing for the env's `extracontext/` directory. Single
 * source of truth is disk under `<envDir>/extracontext/`; durable storage
 * (LOCAL or S3) is mirrored on every write/delete via StorageService so the
 * env survives a clone wipe.
 *
 * The previous Attachment metadata model (per-folder DB rows) was dropped —
 * the tree IS the model. Everything the user uploads, plus everything the
 * AI writes (under `extracontext/ai/` by convention), shows up as plain
 * filesystem entries the user can browse, edit, rename, and delete from the
 * Extra Context tab.
 */
@Injectable()
export class EnvContextService {
  private readonly logger = new Logger(EnvContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly storage: StorageService,
    private readonly codeWorkspace: CodeWorkspaceService,
    private readonly envClones: EnvCloneService
  ) {}

  // ---------- public API --------------------------------------------------

  async tree(
    userId: string,
    workspaceId: string,
    envId: string
  ): Promise<{ root: EnvContextTreeEntry }> {
    await this.assertEnv(userId, workspaceId, envId);
    const root = await this.rootDir(workspaceId, envId);
    await fs.mkdir(root, { recursive: true });
    let stRoot;
    try {
      stRoot = await fs.stat(root);
    } catch {
      stRoot = { mtime: new Date() } as { mtime: Date };
    }
    return {
      root: {
        name: "extracontext",
        path: "",
        kind: "folder",
        size: 0,
        modifiedAt: stRoot.mtime.toISOString(),
        children: await this.walk(root, ""),
      },
    };
  }

  async resolveFileForDownload(
    userId: string,
    workspaceId: string,
    envId: string,
    relPath: string
  ): Promise<{ absPath: string; size: number; filename: string }> {
    await this.assertEnv(userId, workspaceId, envId);
    const root = await this.rootDir(workspaceId, envId);
    const abs = this.resolveSafe(root, relPath);
    if (!abs) throw new NotFoundException("File not found");
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new NotFoundException("File not found");
    }
    if (!st.isFile()) throw new NotFoundException("Not a file");
    return { absPath: abs, size: st.size, filename: path.basename(abs) };
  }

  async upload(
    userId: string,
    workspaceId: string,
    envId: string,
    files: UploadedFile[]
  ): Promise<{ root: EnvContextTreeEntry }> {
    await this.assertEnv(userId, workspaceId, envId);
    if (files.length === 0) {
      throw new BadRequestException("No files uploaded");
    }

    // Normalize + validate every file before any writes.
    const normalized = files.map((f) => {
      const rel = normalizeContextRelPath(f.relPath);
      if (f.buffer.byteLength > MAX_ENV_CONTEXT_FILE_BYTES) {
        throw new BadRequestException(
          `"${rel}" exceeds ${MAX_ENV_CONTEXT_FILE_BYTES / 1024 / 1024}MB per-file limit`
        );
      }
      return { rel, buffer: f.buffer };
    });

    // Quota check against current on-disk state.
    const root = await this.rootDir(workspaceId, envId);
    await fs.mkdir(root, { recursive: true });
    const { fileCount, totalBytes } = await this.measure(root);
    const incomingBytes = normalized.reduce(
      (s, n) => s + n.buffer.byteLength,
      0
    );
    if (fileCount + normalized.length > MAX_ENV_CONTEXT_FILES) {
      throw new BadRequestException(
        `Too many extra-context files — limit ${MAX_ENV_CONTEXT_FILES}`
      );
    }
    if (totalBytes + incomingBytes > MAX_ENV_CONTEXT_TOTAL_BYTES) {
      throw new BadRequestException(
        `Total extra-context size would exceed ${MAX_ENV_CONTEXT_TOTAL_BYTES / 1024 / 1024}MB`
      );
    }

    // Write to durable storage (LOCAL = disk; S3 = bucket).
    for (const n of normalized) {
      await this.storage.writeExtraContextFile(
        workspaceId,
        envId,
        n.rel,
        n.buffer
      );
    }

    // Materialize so a running container sees it via bind-mount, and so the
    // tree endpoint reads the new files.
    await this.storage
      .syncToEnvClone(workspaceId, envId)
      .catch((err) =>
        this.logger.error(
          `syncToEnvClone after extra-context upload failed (env=${envId}): ${err}`
        )
      );

    await this.codeWorkspace.writeWorkspaceFiles(envId);

    this.logger.log(
      `Env ${envId} extra-context: uploaded ${normalized.length} file(s)`
    );
    return this.tree(userId, workspaceId, envId);
  }

  async deleteEntry(
    userId: string,
    workspaceId: string,
    envId: string,
    relPath: string
  ): Promise<{ root: EnvContextTreeEntry }> {
    await this.assertEnv(userId, workspaceId, envId);
    const root = await this.rootDir(workspaceId, envId);
    const abs = this.resolveSafe(root, relPath);
    if (!abs || abs === path.resolve(root)) {
      throw new BadRequestException("Invalid path");
    }
    try {
      await fs.stat(abs);
    } catch {
      throw new NotFoundException("Entry not found");
    }
    // Disk first, then storage (storage is idempotent on missing).
    await fs.rm(abs, { recursive: true, force: true });
    await this.storage
      .deleteExtraContextEntry(workspaceId, envId, relPath)
      .catch((err) =>
        this.logger.warn(
          `Storage delete after extra-context unlink failed (env=${envId}, path=${relPath}): ${err}`
        )
      );
    await this.codeWorkspace.writeWorkspaceFiles(envId);
    this.logger.log(`Env ${envId} extra-context deleted: ${relPath}`);
    return this.tree(userId, workspaceId, envId);
  }

  async renameEntry(
    userId: string,
    workspaceId: string,
    envId: string,
    fromRel: string,
    toRel: string
  ): Promise<{ root: EnvContextTreeEntry }> {
    await this.assertEnv(userId, workspaceId, envId);
    const root = await this.rootDir(workspaceId, envId);
    const fromAbs = this.resolveSafe(root, fromRel);
    const toAbs = this.resolveSafe(root, toRel);
    if (!fromAbs || !toAbs) throw new BadRequestException("Invalid path");
    if (fromAbs === path.resolve(root) || toAbs === path.resolve(root)) {
      throw new BadRequestException("Cannot move/rename the root");
    }
    try {
      await fs.stat(fromAbs);
    } catch {
      throw new NotFoundException("Source not found");
    }
    try {
      await fs.stat(toAbs);
      throw new BadRequestException("Target already exists");
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // not present — good
    }

    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    // Disk rename first.
    await fs.rename(fromAbs, toAbs);

    // Mirror to storage: copy each file under `toRel` and delete the source.
    // For LOCAL mode where storage IS the env clone dir, this is a no-op
    // because the disk rename already moved storage. Detect by computing the
    // would-be storage path and seeing whether it matches the on-disk one.
    await this.mirrorRenameToStorage(workspaceId, envId, fromRel, toRel).catch(
      (err) =>
        this.logger.warn(
          `Storage mirror rename failed (env=${envId}): ${err}`
        )
    );

    await this.codeWorkspace.writeWorkspaceFiles(envId);
    this.logger.log(
      `Env ${envId} extra-context renamed: ${fromRel} -> ${toRel}`
    );
    return this.tree(userId, workspaceId, envId);
  }

  // ---------- internals ---------------------------------------------------

  private async rootDir(
    workspaceId: string,
    envId: string
  ): Promise<string> {
    return path.join(
      this.envClones.envDir(workspaceId, envId),
      "extracontext"
    );
  }

  private resolveSafe(root: string, rel: string): string | null {
    if (path.isAbsolute(rel)) return null;
    const cleaned = rel.replace(/^\.\/+/, "").replace(/\/+$/, "");
    const target = path.resolve(root, cleaned);
    const rootAbs = path.resolve(root);
    if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
      return null;
    }
    return target;
  }

  private async walk(
    absDir: string,
    relPosix: string
  ): Promise<EnvContextTreeEntry[]> {
    let entries: Dirent[];
    try {
      entries = (await fs.readdir(absDir, {
        withFileTypes: true,
        encoding: "utf8",
      })) as Dirent[];
    } catch {
      return [];
    }
    const out: EnvContextTreeEntry[] = [];
    for (const e of entries) {
      // Hide dotfiles to keep the UI clean (.DS_Store, editor swap files).
      if (e.name.startsWith(".")) continue;
      const childRel = relPosix ? `${relPosix}/${e.name}` : e.name;
      const childAbs = path.join(absDir, e.name);
      let st;
      try {
        st = await fs.stat(childAbs);
      } catch {
        continue;
      }
      if (e.isDirectory()) {
        out.push({
          name: e.name,
          path: childRel,
          kind: "folder",
          size: 0,
          modifiedAt: st.mtime.toISOString(),
          children: await this.walk(childAbs, childRel),
        });
      } else if (e.isFile()) {
        out.push({
          name: e.name,
          path: childRel,
          kind: "file",
          size: st.size,
          modifiedAt: st.mtime.toISOString(),
        });
      }
    }
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  /** Walk a directory once, returning aggregate file count + total bytes. */
  private async measure(
    absDir: string
  ): Promise<{ fileCount: number; totalBytes: number }> {
    let fileCount = 0;
    let totalBytes = 0;
    const stack: string[] = [absDir];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: Dirent[];
      try {
        entries = (await fs.readdir(dir, {
          withFileTypes: true,
          encoding: "utf8",
        })) as Dirent[];
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const childAbs = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(childAbs);
        } else if (e.isFile()) {
          try {
            const st = await fs.stat(childAbs);
            fileCount += 1;
            totalBytes += st.size;
          } catch {
            // skip
          }
        }
      }
    }
    return { fileCount, totalBytes };
  }

  /**
   * Walk the renamed tree on disk, write each file to the new storage path,
   * then drop the old storage prefix. Cheap for LOCAL (storage IS disk —
   * deleteExtraContextEntry on the old prefix removes the source) but pays
   * one round-trip per file for S3.
   */
  private async mirrorRenameToStorage(
    workspaceId: string,
    envId: string,
    fromRel: string,
    toRel: string
  ): Promise<void> {
    const root = await this.rootDir(workspaceId, envId);
    const newAbs = this.resolveSafe(root, toRel);
    if (!newAbs) return;
    let st;
    try {
      st = await fs.stat(newAbs);
    } catch {
      return;
    }
    if (st.isFile()) {
      const buf = await fs.readFile(newAbs);
      await this.storage.writeExtraContextFile(
        workspaceId,
        envId,
        toRel,
        buf
      );
    } else if (st.isDirectory()) {
      // Recursively mirror every file under newAbs.
      const stack: { abs: string; rel: string }[] = [
        { abs: newAbs, rel: toRel },
      ];
      while (stack.length) {
        const cur = stack.pop()!;
        const entries = (await fs.readdir(cur.abs, {
          withFileTypes: true,
          encoding: "utf8",
        })) as Dirent[];
        for (const e of entries) {
          if (e.name.startsWith(".")) continue;
          const childAbs = path.join(cur.abs, e.name);
          const childRel = `${cur.rel}/${e.name}`;
          if (e.isDirectory()) {
            stack.push({ abs: childAbs, rel: childRel });
          } else if (e.isFile()) {
            const buf = await fs.readFile(childAbs);
            await this.storage.writeExtraContextFile(
              workspaceId,
              envId,
              childRel,
              buf
            );
          }
        }
      }
    }
    // Now remove the old storage prefix.
    await this.storage.deleteExtraContextEntry(workspaceId, envId, fromRel);
  }

  private async assertEnv(
    userId: string,
    workspaceId: string,
    envId: string
  ): Promise<void> {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }
  }
}
