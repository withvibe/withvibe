import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { mkdir, writeFile } from "fs/promises";
import * as path from "path";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import { TitleGeneratorService } from "./title-generator.service";
import { SessionsService } from "./sessions.service";
import {
  ActiveRunsService,
  type StreamedEvent,
} from "./active-runs.service";
import {
  isAllowedMime,
  safeFilename,
  MAX_ATTACHMENT_FILES,
} from "./attachments.constants";

export type { StreamedEvent } from "./active-runs.service";

/**
 * Derive a short, human-readable title from the first user message of a
 * session. Truncated + ellipsized, ~45 chars. No AI call — stays free + fast.
 */
function titleFromMessage(text: string): string {
  const firstLine =
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? text;
  const cleaned = firstLine.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 45) return cleaned;
  return cleaned.slice(0, 42).trimEnd() + "…";
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService,
    private readonly envClones: EnvCloneService,
    private readonly titles: TitleGeneratorService,
    private readonly sessions: SessionsService,
    private readonly activeRuns: ActiveRunsService
  ) {}

  async list(
    userId: string,
    workspaceId: string,
    envId: string,
    sessionIdParam: string | null
  ) {
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }

    const where: {
      envId: string;
      userId: string;
      sessionId?: string | null;
    } = { envId, userId };

    if (sessionIdParam === "legacy") {
      where.sessionId = null;
    } else if (sessionIdParam) {
      where.sessionId = sessionIdParam;
    }

    const messages = await this.prisma.client.message.findMany({
      where,
      orderBy: { createdAt: "asc" },
      include: {
        attachments: {
          select: {
            id: true,
            mime: true,
            size: true,
            originalName: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    return messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      metadata: m.metadata,
      createdAt: m.createdAt,
      sessionId: m.sessionId,
      attachments: m.attachments,
    }));
  }

  /**
   * Post a user message + start (or queue) a background agent turn. Returns
   * an SSE ReadableStream that subscribes to the session's active run. If a
   * turn is already in flight for this session, the message is **queued** —
   * Claude-Code-style — and dispatched when the current turn finishes. The
   * client never sees a 409. Closing the stream (client disconnect,
   * navigation) only unsubscribes — the run keeps going and can be
   * reattached via the active-run endpoints.
   */
  async postMessage(
    userId: string,
    workspaceId: string,
    envId: string,
    body: { content?: unknown; sessionId?: unknown },
    files: Express.Multer.File[] = []
  ): Promise<ReadableStream<Uint8Array>> {
    // Wall-clock instant the message hit the API — anchors the per-turn
    // waterfall (queue wait + dispatch + ctx-build + SDK call) emitted
    // downstream as `debug_phases`.
    const receivedAt = Date.now();
    await this.access.member(userId, workspaceId);
    const env = await this.prisma.client.env.findUnique({
      where: { id: envId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!env || env.workspaceId !== workspaceId || env.deletedAt) {
      throw new NotFoundException("Env not found");
    }

    const content = typeof body.content === "string" ? body.content.trim() : "";
    // A user message must carry text or at least one attachment — otherwise
    // there's nothing for the agent to act on.
    if (!content && files.length === 0) {
      throw new BadRequestException("Content or attachment required");
    }

    if (files.length > MAX_ATTACHMENT_FILES) {
      throw new BadRequestException(
        `Too many attachments (max ${MAX_ATTACHMENT_FILES})`
      );
    }
    for (const f of files) {
      if (!isAllowedMime(f.mimetype)) {
        throw new BadRequestException(
          `Unsupported file type: ${f.mimetype || "unknown"}`
        );
      }
    }

    // Title fallback when the user only sent attachments — we need *some*
    // text for the session label and the title-generator's first-message hint.
    const titleSource =
      content || (files.length > 0 ? `[${files.length} attachment(s)]` : "");

    // Session: validate if supplied, otherwise auto-create.
    let sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
    let shouldAutoTitle = false;
    if (sessionId) {
      const owned = await this.prisma.client.chatSession.findUnique({
        where: { id: sessionId },
        select: { envId: true, userId: true, title: true },
      });
      if (!owned || owned.envId !== envId || owned.userId !== userId) {
        throw new BadRequestException("Invalid session");
      }
      if (!owned.title) {
        await this.prisma.client.chatSession.update({
          where: { id: sessionId },
          data: { title: titleFromMessage(titleSource) },
        });
        shouldAutoTitle = true;
      }
    } else {
      const created = await this.prisma.client.chatSession.create({
        data: { envId, userId, title: titleFromMessage(titleSource) },
      });
      sessionId = created.id;
      shouldAutoTitle = true;
    }

    if (shouldAutoTitle) {
      void this.titles.generate({
        sessionId,
        firstMessage: titleSource,
        workspaceId,
      });
    }

    const preview = content.length > 80 ? content.slice(0, 77) + "…" : content;
    this.logger.log(
      `Message posted: env=${envId} session=${sessionId} user=${userId} files=${files.length} "${preview}"`
    );

    const userMessage = await this.prisma.client.message.create({
      data: { envId, userId, sessionId, role: "user", content },
    });

    // Persist attachments under the env's working directory so the agent can
    // `Read` them with cwd-relative paths. Anything that fails to write is
    // logged + surfaced via BadRequestException so we don't start a run that
    // references missing files.
    const persistedAttachments = await this.persistAttachments(
      workspaceId,
      envId,
      userMessage.id,
      files
    );

    const promptForAgent = this.buildPrompt(content, persistedAttachments);

    // Either starts a new turn or queues behind the live one — the stream
    // we hand back is the same in both cases (subscribes to the session run).
    this.activeRuns.enqueue({
      envId,
      workspaceId,
      userId,
      sessionId,
      prompt: promptForAgent,
      userMessageId: userMessage.id,
      receivedAt,
    });

    return this.subscribeStream(sessionId);
  }

  /**
   * Post a message into an existing, owned session and start (or queue) an
   * agent turn — the same pipeline as {@link postMessage} but without
   * building the SSE stream. The caller gets back just the sessionId and is
   * expected to subscribe to the run via the active-run endpoints. Used by
   * automated kickoffs (e.g. the Security scan) where there is no
   * interactive composer and the prompt is machine-generated.
   */
  async startSessionTurn(
    userId: string,
    workspaceId: string,
    envId: string,
    sessionId: string,
    content: string
  ): Promise<{ sessionId: string }> {
    const receivedAt = Date.now();
    const owned = await this.sessions.assertSessionOwned(
      userId,
      workspaceId,
      envId,
      sessionId
    );

    // Mirror postMessage's auto-title so a freshly-created scan session
    // doesn't show up untitled in the chat session list.
    if (!owned.title) {
      await this.prisma.client.chatSession.update({
        where: { id: sessionId },
        data: { title: titleFromMessage(content) },
      });
    }

    const userMessage = await this.prisma.client.message.create({
      data: { envId, userId, sessionId, role: "user", content },
    });

    this.activeRuns.enqueue({
      envId,
      workspaceId,
      userId,
      sessionId,
      prompt: content,
      userMessageId: userMessage.id,
      receivedAt,
    });

    return { sessionId };
  }

  /**
   * Write each upload into `<envDir>/.uploads/<messageId>/<safe-name>` and
   * record an Attachment row. Returns the list of stored items so the caller
   * can fold them into the agent prompt. Filename collisions inside the same
   * message get a numeric suffix.
   */
  private async persistAttachments(
    workspaceId: string,
    envId: string,
    messageId: string,
    files: Express.Multer.File[]
  ): Promise<{ relPath: string; mime: string; originalName: string }[]> {
    if (files.length === 0) return [];
    const envDir = this.envClones.envDir(workspaceId, envId);
    const dirRel = path.posix.join(".uploads", messageId);
    const dirAbs = path.join(envDir, ".uploads", messageId);
    await mkdir(dirAbs, { recursive: true });

    const used = new Set<string>();
    const stored: {
      relPath: string;
      mime: string;
      originalName: string;
    }[] = [];

    for (const f of files) {
      // Collision-proof a sanitized filename against earlier uploads in the
      // same message (e.g. two `image.png` from different sources).
      let name = safeFilename(f.originalname);
      if (used.has(name)) {
        const ext = path.extname(name);
        const stem = ext ? name.slice(0, -ext.length) : name;
        let n = 2;
        while (used.has(`${stem}-${n}${ext}`)) n += 1;
        name = `${stem}-${n}${ext}`;
      }
      used.add(name);

      const absPath = path.join(dirAbs, name);
      await writeFile(absPath, f.buffer);
      const relPath = path.posix.join(dirRel, name);

      await this.prisma.client.attachment.create({
        data: {
          messageId,
          envId,
          workspaceId,
          path: relPath,
          mime: f.mimetype,
          size: f.size,
          originalName: f.originalname,
        },
      });

      stored.push({
        relPath,
        mime: f.mimetype,
        originalName: f.originalname,
      });
    }

    return stored;
  }

  /**
   * Compose the final prompt sent to the agent. We append a structured block
   * that lists each attached file by its cwd-relative path so the model knows
   * to use the `Read` tool. Pure text messages pass through untouched.
   */
  private buildPrompt(
    userText: string,
    attachments: { relPath: string; mime: string; originalName: string }[]
  ): string {
    if (attachments.length === 0) return userText;
    const lines = attachments.map(
      (a) => `- ${a.relPath}  (${a.mime}, original: "${a.originalName}")`
    );
    const block = [
      "",
      "Attached files (use the Read tool to inspect them; paths are relative to your cwd):",
      ...lines,
    ].join("\n");
    return userText ? `${userText}\n${block}` : block.trimStart();
  }

  /**
   * Build a ReadableStream that subscribes to the session's active run and
   * emits SSE frames. Closes when the run ends (`run_ended` event).
   * Cancelling the stream only unsubscribes — it does not stop the run.
   */
  subscribeStream(sessionId: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const activeRuns = this.activeRuns;

    let unsubscribe: (() => void) | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    return new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const safeClose = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
          }
          try {
            controller.close();
          } catch {}
        };

        const subscriber = (ev: StreamedEvent) => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(ev)}\n\n`)
            );
          } catch {
            // Controller already closed — nothing to do.
            closed = true;
            return;
          }
          // session_idle is the terminal frame — emitted only when the
          // current turn is done AND the queue is fully drained. run_ended
          // by itself just means a turn boundary; another auto-dispatched
          // turn may follow on the same stream.
          if (ev.type === "session_idle") safeClose();
        };

        const unsub = activeRuns.subscribe(sessionId, subscriber);
        if (!unsub) {
          // No active run. Emit a synthetic idle marker and close so the
          // client knows there's nothing to watch.
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "session_idle" })}\n\n`
            )
          );
          safeClose();
          return;
        }
        unsubscribe = unsub;

        // Heartbeat — an SSE comment frame every 15s keeps intermediaries
        // (undici's 5min body timeout, reverse proxies) from killing the
        // connection during long quiet stretches (e.g. docker build).
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`: keepalive\n\n`));
          } catch {
            closed = true;
          }
        }, 15_000);
      },
      cancel() {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        unsubscribe?.();
      },
    });
  }

  /** Returns the active-run summary for a session, or null. */
  async getActiveRun(
    userId: string,
    workspaceId: string,
    envId: string,
    sessionId: string
  ): Promise<{
    runId: string;
    status: "running" | "done" | "error" | "interrupted";
    sessionId: string;
    startedAt: string;
    queuedCount: number;
  } | null> {
    await this.access.member(userId, workspaceId);
    await this.sessions.assertSessionOwned(userId, workspaceId, envId, sessionId);
    const run = this.activeRuns.get(sessionId);
    if (!run) return null;
    return {
      runId: run.runId,
      status: run.status,
      sessionId: run.sessionId,
      startedAt: run.startedAt.toISOString(),
      queuedCount: this.activeRuns.pendingCount(sessionId),
    };
  }

  /** Subscribe to the session's active-run event stream (SSE). */
  async subscribeActiveRun(
    userId: string,
    workspaceId: string,
    envId: string,
    sessionId: string
  ): Promise<ReadableStream<Uint8Array>> {
    await this.access.member(userId, workspaceId);
    await this.sessions.assertSessionOwned(userId, workspaceId, envId, sessionId);
    return this.subscribeStream(sessionId);
  }

  /**
   * Interrupt the in-flight turn for a session. Aborts the engine and drops
   * any queued user messages that haven't been dispatched yet. No-op (returns
   * `running: false`) if there's nothing to interrupt.
   */
  async interrupt(
    userId: string,
    workspaceId: string,
    envId: string,
    sessionId: string
  ): Promise<{ interrupted: boolean }> {
    await this.access.member(userId, workspaceId);
    await this.sessions.assertSessionOwned(userId, workspaceId, envId, sessionId);
    const ok = this.activeRuns.interrupt(sessionId);
    return { interrupted: ok };
  }
}
