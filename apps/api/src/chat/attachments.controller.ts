import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  UseGuards,
} from "@nestjs/common";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import * as path from "path";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { EnvCloneService } from "../env-clones/env-clone.service";

/**
 * Stream a chat-message attachment back to any member of the env's workspace.
 * Files live on disk under the env clone dir (`<envDir>/.uploads/<msgId>/…`).
 * The download path is computed from the DB row, never from user input —
 * `path` is stored normalized at upload time.
 */
@Controller("workspaces/:workspaceId/envs/:envId/attachments")
@UseGuards(JwtAuthGuard)
export class AttachmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly envClones: EnvCloneService
  ) {}

  @Get(":attId")
  async download(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("attId") attId: string,
    @Res() res: Response
  ) {
    await this.access.member(user.id, workspaceId);

    const att = await this.prisma.client.attachment.findUnique({
      where: { id: attId },
      select: {
        envId: true,
        workspaceId: true,
        path: true,
        mime: true,
        originalName: true,
      },
    });
    if (!att || att.envId !== envId || att.workspaceId !== workspaceId) {
      throw new NotFoundException("Attachment not found");
    }

    const envDir = this.envClones.envDir(workspaceId, envId);
    const absPath = path.resolve(envDir, att.path);
    // Defense-in-depth — refuse anything that resolved outside envDir even
    // though `path` is constructed server-side. Cheap and self-documenting.
    if (!absPath.startsWith(path.resolve(envDir) + path.sep)) {
      throw new NotFoundException("Attachment not found");
    }

    let size: number;
    try {
      const s = await stat(absPath);
      size = s.size;
    } catch {
      throw new NotFoundException("Attachment file missing");
    }

    res.setHeader("Content-Type", att.mime || "application/octet-stream");
    res.setHeader("Content-Length", String(size));
    // Inline so images render in <img>; browsers will still let users save.
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(att.originalName)}"`
    );
    res.setHeader("Cache-Control", "private, max-age=3600");

    createReadStream(absPath).pipe(res);
  }
}
