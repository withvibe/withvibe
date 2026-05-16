import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { EnvAssetsService } from "./env-assets.service";
import {
  MAX_ENV_ASSETS_TOTAL_BYTES,
  MAX_ENV_ASSET_FILES,
  MAX_ENV_ASSET_FILE_BYTES,
} from "./envs.service";

@Controller("workspaces/:workspaceId/envs/:envId/assets")
@UseGuards(JwtAuthGuard)
export class EnvAssetsController {
  constructor(private readonly assets: EnvAssetsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string
  ) {
    return this.assets.list(user.id, workspaceId, envId);
  }

  @Post()
  @UseInterceptors(
    FilesInterceptor("files", MAX_ENV_ASSET_FILES, {
      limits: {
        fileSize: MAX_ENV_ASSET_FILE_BYTES,
        files: MAX_ENV_ASSET_FILES,
        fieldSize: MAX_ENV_ASSETS_TOTAL_BYTES,
      },
    })
  )
  async upload(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @UploadedFiles() files: Express.Multer.File[]
  ) {
    // Client must send each file's relative path as the `originalname`
    // (webkitRelativePath or plain filename). Kept intentionally flat so
    // folder structure is preserved on disk.
    const uploaded = (files ?? []).map((f) => ({
      relativePath: f.originalname,
      buffer: f.buffer,
    }));
    return this.assets.upload(user.id, workspaceId, envId, uploaded);
  }

  @Delete(":assetPath(*)")
  delete(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Param("assetPath") assetPath: string
  ) {
    return this.assets.delete(
      user.id,
      workspaceId,
      envId,
      decodeURIComponent(assetPath)
    );
  }
}
