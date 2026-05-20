import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { createReadStream } from "fs";
import * as path from "path";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { EnvContextService } from "./env-context.service";
import {
  MAX_ENV_CONTEXT_FILES,
  MAX_ENV_CONTEXT_FILE_BYTES,
  MAX_ENV_CONTEXT_TOTAL_BYTES,
} from "./env-context-types";

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * REST surface for the env's `extracontext/` filesystem tree. The tree is
 * the only model — there's no Attachment metadata behind it. Users browse,
 * download, upload, rename, and delete entries; the AI uses its native
 * Write/Edit tools (and the `render_pdf` MCP tool) to drop deliverables
 * under `extracontext/ai/` by convention.
 */
@Controller("workspaces/:workspaceId/envs/:envId/context")
@UseGuards(JwtAuthGuard)
export class EnvContextController {
  constructor(private readonly context: EnvContextService) {}

  @Get("tree")
  tree(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.context.tree(user.id, workspaceId, envId);
  }

  @Get("file")
  async download(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Query("path") relPath: string,
    @Query("disposition") disposition: string | undefined,
    @Res() res: Response
  ) {
    if (!relPath) throw new BadRequestException("Missing path query param");
    const { absPath, size, filename } =
      await this.context.resolveFileForDownload(
        user.id,
        workspaceId,
        envId,
        relPath
      );
    const ext = path.extname(absPath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    const isAttachment = disposition === "attachment";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(size));
    res.setHeader(
      "Content-Disposition",
      `${isAttachment ? "attachment" : "inline"}; filename="${encodeURIComponent(filename)}"`
    );
    res.setHeader("Cache-Control", "private, no-cache");
    createReadStream(absPath).pipe(res);
  }

  @Post("upload")
  @UseInterceptors(
    FilesInterceptor("files", MAX_ENV_CONTEXT_FILES, {
      limits: {
        fileSize: MAX_ENV_CONTEXT_FILE_BYTES,
        files: MAX_ENV_CONTEXT_FILES,
        fieldSize: MAX_ENV_CONTEXT_TOTAL_BYTES,
      },
    })
  )
  async upload(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body("destDir") destDirRaw: string,
    @Body("paths") pathsRaw: string | undefined,
    @UploadedFiles() files: Express.Multer.File[]
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException("No files uploaded");
    }
    const destDir = (destDirRaw ?? "").trim().replace(/^\/+|\/+$/g, "");
    // The browser strips path separators from multipart filenames, so we can't
    // recover folder structure from `originalname`. The frontend sends a
    // parallel `paths` array (JSON) carrying each file's webkitRelativePath;
    // pair them by index and fall back to originalname if missing.
    let paths: string[] | null = null;
    if (pathsRaw) {
      try {
        const parsed = JSON.parse(pathsRaw);
        if (
          Array.isArray(parsed) &&
          parsed.every((p) => typeof p === "string")
        ) {
          paths = parsed as string[];
        }
      } catch {
        throw new BadRequestException("Invalid paths field");
      }
    }
    const items = files.map((f, i) => {
      const raw = paths?.[i] ?? f.originalname;
      const cleaned = raw.replace(/\\/g, "/").replace(/^\/+/, "");
      const rel = destDir ? `${destDir}/${cleaned}` : cleaned;
      return { relPath: rel, buffer: f.buffer };
    });
    return this.context.upload(user.id, workspaceId, envId, items);
  }

  @Delete("entry")
  async deleteEntry(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Query("path") relPath: string
  ) {
    if (!relPath) throw new BadRequestException("Missing path query param");
    return this.context.deleteEntry(user.id, workspaceId, envId, relPath);
  }

  @Patch("entry")
  async renameEntry(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { fromPath?: string; toPath?: string }
  ) {
    const fromPath = body?.fromPath?.trim();
    const toPath = body?.toPath?.trim();
    if (!fromPath || !toPath) {
      throw new BadRequestException("fromPath and toPath are required");
    }
    return this.context.renameEntry(
      user.id,
      workspaceId,
      envId,
      fromPath,
      toPath
    );
  }

  /**
   * Create an empty folder. `path` is relative to extracontext/. Parent dirs
   * are created automatically (mkdir -p semantics). Idempotent: an already-
   * existing folder at the same path is a no-op.
   */
  @Post("folder")
  async createFolder(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { path?: string }
  ) {
    const relPath = body?.path?.trim();
    if (!relPath) throw new BadRequestException("path is required");
    return this.context.createFolder(user.id, workspaceId, envId, relPath);
  }

  /**
   * Create a new (possibly empty) file. Errors if anything already exists at
   * `path` — the user must call DELETE first or pick a different name. The
   * optional `content` lets the FE seed the file with text (e.g. a template).
   */
  @Post("file")
  async createFile(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { path?: string; content?: string }
  ) {
    const relPath = body?.path?.trim();
    if (!relPath) throw new BadRequestException("path is required");
    const content = typeof body?.content === "string" ? body.content : "";
    return this.context.createFile(
      user.id,
      workspaceId,
      envId,
      relPath,
      content
    );
  }

  /**
   * Save (create-or-overwrite) a text file. Used by the in-app Monaco
   * editor; idempotent unlike POST /file which refuses to overwrite. Refuses
   * to clobber a folder.
   */
  @Put("file")
  async writeFile(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { path?: string; content?: string }
  ) {
    const relPath = body?.path?.trim();
    if (!relPath) throw new BadRequestException("path is required");
    const content = typeof body?.content === "string" ? body.content : "";
    return this.context.writeFile(
      user.id,
      workspaceId,
      envId,
      relPath,
      content
    );
  }

  /**
   * Read a text file's contents for the in-app editor. Refuses binaries and
   * files past MAX_ENV_CONTEXT_EDITABLE_BYTES. For raw download / binaries,
   * use GET /file (alongside the existing endpoint above).
   */
  @Get("file/text")
  async readText(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Query("path") relPath: string
  ) {
    if (!relPath) throw new BadRequestException("Missing path query param");
    return this.context.readFileText(user.id, workspaceId, envId, relPath);
  }
}

