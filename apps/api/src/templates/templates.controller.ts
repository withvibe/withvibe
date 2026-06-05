import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthUser } from "../auth/jwt.strategy";
import { DemoModeService } from "../common/demo-mode.service";
import { TemplatesService } from "./templates.service";
import {
  TemplateAssistService,
  type AssistRequest,
} from "./template-assist.service";

@Controller("workspaces/:workspaceId/env-templates")
@UseGuards(JwtAuthGuard)
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly assist: TemplateAssistService,
    private readonly demo: DemoModeService
  ) {}

  /** Template authoring is disabled for demo visitors. */
  private assertNotDemo() {
    if (this.demo.enabled) {
      throw new ForbiddenException(
        "Template authoring is disabled in demo mode"
      );
    }
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string
  ) {
    return this.templates.list(user.id, workspaceId);
  }

  @Get(":templateId")
  detail(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string
  ) {
    return this.templates.detail(user.id, workspaceId, templateId);
  }

  @Post()
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Body() body: Record<string, unknown>
  ) {
    this.assertNotDemo();
    return this.templates.create(user.id, workspaceId, body);
  }

  @Patch(":templateId")
  update(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string,
    @Body() body: Record<string, unknown>
  ) {
    this.assertNotDemo();
    return this.templates.update(user.id, workspaceId, templateId, body);
  }

  @Delete(":templateId")
  delete(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Param("templateId") templateId: string
  ) {
    this.assertNotDemo();
    return this.templates.delete(user.id, workspaceId, templateId);
  }

  /**
   * Streaming AI assistant for template authoring. The browser sends the
   * current editor state on every turn — we don't persist it server-side.
   * Tool calls flow back as SSE events that the UI surfaces as accept/reject
   * diff cards.
   */
  @Post("assist")
  async runAssist(
    @CurrentUser() user: AuthUser,
    @Param("workspaceId") workspaceId: string,
    @Body() body: AssistRequest,
    @Res() res: Response
  ) {
    this.assertNotDemo();
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.assist.assist(user.id, workspaceId, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ message });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    if (typeof (res as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as unknown as { flushHeaders: () => void }).flushHeaders();
    }

    const reader = stream.getReader();
    let clientGone = false;
    const onClose = () => {
      if (clientGone) return;
      clientGone = true;
      void reader.cancel().catch(() => {});
    };
    res.on("close", onClose);
    res.on("error", onClose);

    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientGone) break;
          const ok = res.write(Buffer.from(value));
          if (!ok)
            await new Promise<void>((resolve) => res.once("drain", resolve));
        }
      } catch {
        // client likely disconnected mid-write
      } finally {
        try {
          res.end();
        } catch {}
      }
    })();
  }
}
