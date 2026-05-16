import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { MessagesService } from "./messages.service";
import {
  MAX_ATTACHMENT_FILES,
  MAX_ATTACHMENT_FILE_BYTES,
} from "./attachments.constants";

@Controller("workspaces/:workspaceId/envs/:envId/messages")
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Query("sessionId") sessionId?: string
  ) {
    return this.messages.list(user.id, workspaceId, envId, sessionId ?? null);
  }

  /**
   * Streams the assistant reply as SSE. Accepts both `application/json` (no
   * attachments) and `multipart/form-data` (uploads under the `files` field +
   * `content`/`sessionId` text fields). FilesInterceptor short-circuits
   * non-multipart requests, so JSON callers are unaffected.
   *
   * We use `@Res() passthrough=false` so we can pipe a `ReadableStream`
   * directly into the Express response with the right headers. Nest's `@Sse()`
   * decorator doesn't fit here because the stream body is assembled inside
   * the service.
   */
  @Post()
  @UseInterceptors(
    FilesInterceptor("files", MAX_ATTACHMENT_FILES, {
      limits: {
        fileSize: MAX_ATTACHMENT_FILE_BYTES,
        files: MAX_ATTACHMENT_FILES,
      },
    })
  )
  async post(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { content?: unknown; sessionId?: unknown },
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @Res() res: Response
  ) {
    const stream = await this.messages.postMessage(
      user.id,
      workspaceId,
      envId,
      body,
      files ?? []
    );
    this.pipeSse(stream, res);
  }

  /**
   * Active-run summary for a session. The `sessionId` query param is required
   * — different sessions in the same env have independent runs (Claude-Code-
   * style: shared cwd, user-coordinated).
   */
  @Get("/active-run")
  async activeRun(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Query("sessionId") sessionId?: string
  ) {
    if (!sessionId) {
      throw new BadRequestException("sessionId query param is required");
    }
    return (
      (await this.messages.getActiveRun(user.id, workspaceId, envId, sessionId)) ?? {
        status: "idle" as const,
      }
    );
  }

  @Get("/active-run/stream")
  async activeRunStream(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Res() res: Response,
    @Query("sessionId") sessionId?: string
  ) {
    if (!sessionId) {
      throw new BadRequestException("sessionId query param is required");
    }
    const stream = await this.messages.subscribeActiveRun(
      user.id,
      workspaceId,
      envId,
      sessionId
    );
    this.pipeSse(stream, res);
  }

  /**
   * Interrupt the running turn for a session. Aborts the engine and drops
   * any queued user messages. Returns `{ interrupted: true }` if a run was
   * running, `{ interrupted: false }` otherwise.
   */
  @Post("/interrupt")
  async interrupt(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("envId") envId: string,
    @Body() body: { sessionId?: unknown }
  ) {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
    if (!sessionId) {
      throw new BadRequestException("sessionId is required");
    }
    return this.messages.interrupt(user.id, workspaceId, envId, sessionId);
  }

  /**
   * Pipe a Web `ReadableStream` into an Express response as SSE. If the
   * client disconnects (navigates, closes the tab), we cancel the reader to
   * release the subscription — but the underlying agent run keeps going so
   * a reconnect can pick up where this left off.
   */
  private pipeSse(stream: ReadableStream<Uint8Array>, res: Response) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Flush headers so clients see the stream open immediately.
    if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as unknown as { flushHeaders: () => void }).flushHeaders();
    }

    const reader = stream.getReader();
    let clientGone = false;

    const onClose = () => {
      if (clientGone) return;
      clientGone = true;
      // Cancel the reader so the underlying subscription unsubscribes.
      void reader.cancel().catch(() => {});
    };
    res.on("close", onClose);
    res.on("error", onClose);

    const pump = async (): Promise<void> => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientGone) break;
          const ok = res.write(Buffer.from(value));
          if (!ok) {
            // Backpressure — wait for drain so we don't blow memory on slow
            // clients.
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
      } catch {
        // Client likely disconnected mid-write. Handled by close listener.
      } finally {
        try {
          res.end();
        } catch {}
      }
    };
    void pump();
  }
}
