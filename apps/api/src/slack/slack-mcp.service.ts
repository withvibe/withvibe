import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpServerSpec,
  McpToolDescriptor,
} from "../mcp-bridge/mcp-tool-types";
import { PrismaService } from "../prisma/prisma.service";
import { EnvCloneService } from "../env-clones/env-clone.service";
import { SlackService } from "./slack.service";

// Sanity cap for files the agent uploads via the Slack tools. Slack itself
// allows up to 1GB, but anything over a few MB is almost certainly the
// agent attaching the wrong thing — keep tight, raise if we hit real cases.
const MAX_SLACK_UPLOAD_BYTES = 50 * 1024 * 1024;

// Shared `file_path` fragment — added to every Slack-sending tool. Paths are
// resolved relative to the env's working directory (the same cwd the agent
// has) and validated to be inside it. When set, the tool uploads the file
// with the tool's text as its initial comment, instead of plain
// chat.postMessage.
const SLACK_FILE_PATH_FIELD = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Optional path to a file to attach, relative to the env's working directory (e.g. 'extracontext/ai/docs/spec.md', 'src/auth/login.ts'). " +
      "Must stay inside the env dir — no leading slash, no `..`. " +
      "Max 50MB. When set, the message/question/summary becomes the file's caption in Slack."
  );

const SLACK_NOTIFY_SHAPE = {
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Slack channel name (with or without leading #) or channel ID (C…/G…). Provide EITHER `channel` or `member_email`, not both."
    ),
  member_email: z
    .string()
    .email()
    .optional()
    .describe(
      "Email of a workspace teammate. The tool resolves their Slack user and sends a DM. Provide EITHER `channel` or `member_email`, not both."
    ),
  message: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "Plain text or Slack mrkdwn. Self-contained: include any context the reader needs."
    ),
  file_path: SLACK_FILE_PATH_FIELD,
};

const SLACK_ASK_SHAPE = {
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Slack channel name (with or without leading #) or channel ID. Anyone in the channel can answer in-thread. Provide EITHER `channel` or `member_email`."
    ),
  member_email: z
    .string()
    .email()
    .optional()
    .describe(
      "Email of the specific teammate to ask. Sent as a DM; only their thread reply counts. Provide EITHER `channel` or `member_email`."
    ),
  question: z
    .string()
    .min(10)
    .max(2000)
    .describe(
      "The question in plain English. Self-contained: include any context the recipient needs to answer without seeing this chat."
    ),
  context: z
    .string()
    .max(1000)
    .optional()
    .describe(
      "Optional one-paragraph background — what you're working on and why you need this answer. Appears below the question."
    ),
  file_path: SLACK_FILE_PATH_FIELD,
};

const SLACK_CONTINUE_SHAPE = {
  request_id: z
    .string()
    .min(1)
    .describe(
      "The `request_id` returned by `slack_ask`. Identifies which Slack thread to post into."
    ),
  message: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      "Your follow-up message — posted as a thread reply on Slack. The recipient's next reply will come back to this chat the same way the first one did."
    ),
  file_path: SLACK_FILE_PATH_FIELD,
};

const SLACK_CONCLUDE_SHAPE = {
  request_id: z
    .string()
    .min(1)
    .describe(
      "The `request_id` returned by `slack_ask`. Marks that Slack thread as concluded."
    ),
  summary: z
    .string()
    .min(1)
    .max(2000)
    .describe(
      "A short summary of what you learned from the Slack conversation. Posted as a final thread reply on Slack ('Thanks, wrapping up:'), and used by the WithVibe UI to collapse all intermediate Slack-reply cards into a single conclusion."
    ),
  file_path: SLACK_FILE_PATH_FIELD,
};

type ResolvedTarget =
  | { kind: "channel"; channel: string; label: string }
  | { kind: "dm"; channel: string; label: string };

type TargetResult =
  | { ok: true; target: ResolvedTarget }
  | { ok: false; error: CallToolResult };

/**
 * MCP server exposing the two Slack tools:
 *   - slack_notify  (always available when bot token is connected — Phase 2)
 *   - slack_ask     (available only when the app-level token is ALSO
 *                    connected and the agent is in a bound chat session —
 *                    Phase 3 two-way flow)
 *
 * Workspace + session scope is baked in per-context via `describeMcpServer`,
 * so the agent never sees tokens or session ids in its tool calls.
 */
@Injectable()
export class SlackMcpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slack: SlackService,
    private readonly envClones: EnvCloneService
  ) {}

  describeMcpServer(opts: {
    workspaceId: string;
    envId?: string;
    sessionId?: string | null;
    agentId?: string | null;
    /**
     * True when the workspace has both Slack tokens AND there's a session
     * the reply can be routed back to. False degrades the server to
     * notify-only.
     */
    asksEnabled: boolean;
  }): McpServerSpec {
    const tools: McpToolDescriptor[] = [
      this.buildNotifyTool({
        workspaceId: opts.workspaceId,
        envId: opts.envId ?? null,
      }),
    ];
    if (opts.asksEnabled && opts.sessionId && opts.envId) {
      const scope = {
        workspaceId: opts.workspaceId,
        envId: opts.envId,
        sessionId: opts.sessionId,
        agentId: opts.agentId ?? null,
      };
      tools.push(
        this.buildAskTool(scope),
        this.buildContinueThreadTool(scope),
        this.buildConcludeTool(scope)
      );
    }
    return {
      name: "withvibe-slack",
      version: "1.0.0",
      tools,
    };
  }

  createMcpServer(opts: {
    workspaceId: string;
    envId?: string;
    sessionId?: string | null;
    agentId?: string | null;
    asksEnabled: boolean;
  }): McpSdkServerConfigWithInstance {
    const spec = this.describeMcpServer(opts);
    return createSdkMcpServer({
      name: spec.name,
      version: spec.version,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.inputShape, t.handler)
      ),
    });
  }

  private buildNotifyTool(scope: {
    workspaceId: string;
    envId: string | null;
  }): McpToolDescriptor<typeof SLACK_NOTIFY_SHAPE> {
    const self = this;
    return {
      name: "slack_notify",
      description:
        "Post a one-way message to a Slack channel or DM a teammate by email. Fire-and-forget — does NOT wait for a reply (use `slack_ask` when you need an answer). Optionally attach a file from the env's working directory via `file_path` — the message text becomes the file's caption. Returns the Slack message timestamp on success.",
      inputShape: SLACK_NOTIFY_SHAPE,
      async handler(raw) {
        const input = z.object(SLACK_NOTIFY_SHAPE).parse(raw);
        const resolved = await self.resolveTarget(scope.workspaceId, {
          channel: input.channel,
          member_email: input.member_email,
        });
        if (!resolved.ok) return resolved.error;
        const token = await self.requireBotToken(scope.workspaceId);
        if (typeof token !== "string") return token;
        const file = await self.maybeResolveFile({
          workspaceId: scope.workspaceId,
          envId: scope.envId,
          filePath: input.file_path,
        });
        if (file && !file.ok) return file.error;

        try {
          if (file) {
            await self.slack.uploadFile(token, {
              channel: resolved.target.channel,
              file: file.buffer,
              filename: file.filename,
              initialComment: input.message,
            });
            return ok(
              `Uploaded ${file.filename} (${file.buffer.length} bytes) to ${resolved.target.label} with caption.`
            );
          }
          const res = await self.slack.postMessage(token, {
            channel: resolved.target.channel,
            text: input.message,
          });
          return ok(`Posted to ${resolved.target.label}. ts=${res.ts}`);
        } catch (err) {
          return errorResult(
            err instanceof Error
              ? `Slack post failed: ${err.message}`
              : "Slack post failed"
          );
        }
      },
    };
  }

  private buildAskTool(scope: {
    workspaceId: string;
    envId: string;
    sessionId: string;
    agentId: string | null;
  }): McpToolDescriptor<typeof SLACK_ASK_SHAPE> {
    const self = this;
    return {
      name: "slack_ask",
      description:
        "Ask a teammate (DM) or channel a question on Slack. ASYNCHRONOUS — does not block. Their reply in the Slack thread will be delivered to you automatically as a new message in this chat. " +
        "If their first reply doesn't answer the question, call `slack_continue_thread` to ask a follow-up in the same Slack thread — DON'T spam this chat with intermediate back-and-forth. " +
        "When the Slack conversation has resolved the question, call `slack_conclude` with a short summary; the UI collapses the intermediate cards so the asker sees only the conclusion. " +
        "Use this only when the answer can't be inferred from the repo, env knowledge, or prior memory.",
      inputShape: SLACK_ASK_SHAPE,
      async handler(raw) {
        const input = z.object(SLACK_ASK_SHAPE).parse(raw);
        const resolved = await self.resolveTarget(scope.workspaceId, {
          channel: input.channel,
          member_email: input.member_email,
        });
        if (!resolved.ok) return resolved.error;
        const token = await self.requireBotToken(scope.workspaceId);
        if (typeof token !== "string") return token;
        // File (if any) gets attached as a thread reply AFTER the question
        // is posted — Slack's file upload API doesn't reliably hand us back
        // the parent message ts, and we need that ts to track future
        // replies on the question.
        const file = await self.maybeResolveFile({
          workspaceId: scope.workspaceId,
          envId: scope.envId,
          filePath: input.file_path,
        });
        if (file && !file.ok) return file.error;

        const text =
          `:wave: *Question from WithVibe*` +
          (input.context ? `\n_Context:_ ${input.context}` : "") +
          `\n\n${input.question}` +
          (file ? `\n\n_Attached: ${file.filename}_` : "") +
          `\n\n_Reply in this thread — your answer goes back to the agent automatically._`;

        let postRes: { channel: string; ts: string };
        try {
          postRes = await self.slack.postMessage(token, {
            channel: resolved.target.channel,
            text,
          });
        } catch (err) {
          return errorResult(
            err instanceof Error
              ? `Slack ask failed: ${err.message}`
              : "Slack ask failed"
          );
        }

        if (file) {
          try {
            await self.slack.uploadFile(token, {
              channel: postRes.channel,
              file: file.buffer,
              filename: file.filename,
              threadTs: postRes.ts,
            });
          } catch (err) {
            // File upload failed but the question is already out — note it
            // in the response but don't roll back the question.
            return errorResult(
              `Question was posted but file upload failed: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }

        const pending = await self.prisma.client.slackPendingQuestion.create({
          data: {
            workspaceId: scope.workspaceId,
            chatSessionId: scope.sessionId,
            envId: scope.envId,
            agentId: scope.agentId,
            slackChannel: postRes.channel,
            slackThreadTs: postRes.ts,
            askedEmail: input.member_email ?? null,
            askedSlackUserId:
              resolved.target.kind === "dm" ? resolved.target.channel : null,
            question: input.question,
          },
        });

        return ok(
          `Question posted to ${resolved.target.label}. request_id=${pending.id}. They'll reply in the Slack thread; their answer will arrive here as a new message. Continue with what you can do in the meantime.`
        );
      },
    };
  }

  private buildContinueThreadTool(scope: {
    workspaceId: string;
    envId: string;
    sessionId: string;
  }): McpToolDescriptor<typeof SLACK_CONTINUE_SHAPE> {
    const self = this;
    return {
      name: "slack_continue_thread",
      description:
        "Post a follow-up message in the existing Slack thread for a `slack_ask` you already sent. Use this when you need more clarification from the same person before you can answer — keeps the conversation in Slack instead of cluttering this chat. Optionally attach a file from the env via `file_path` — the message becomes its caption. Their next reply will come back here the same way the first one did.",
      inputShape: SLACK_CONTINUE_SHAPE,
      async handler(raw) {
        const input = z.object(SLACK_CONTINUE_SHAPE).parse(raw);
        const pending =
          await self.prisma.client.slackPendingQuestion.findUnique({
            where: { id: input.request_id },
            select: {
              workspaceId: true,
              chatSessionId: true,
              slackChannel: true,
              slackThreadTs: true,
              concludedAt: true,
            },
          });
        if (!pending) {
          return errorResult(
            `No Slack thread found for request_id=${input.request_id}.`
          );
        }
        if (
          pending.workspaceId !== scope.workspaceId ||
          pending.chatSessionId !== scope.sessionId
        ) {
          return errorResult(
            "This request_id belongs to a different session/workspace."
          );
        }
        if (pending.concludedAt) {
          return errorResult(
            "This Slack thread has already been concluded — open a new one with `slack_ask` if you need to follow up."
          );
        }
        const token = await self.requireBotToken(scope.workspaceId);
        if (typeof token !== "string") return token;
        const file = await self.maybeResolveFile({
          workspaceId: scope.workspaceId,
          envId: scope.envId,
          filePath: input.file_path,
        });
        if (file && !file.ok) return file.error;
        try {
          if (file) {
            await self.slack.uploadFile(token, {
              channel: pending.slackChannel,
              file: file.buffer,
              filename: file.filename,
              initialComment: input.message,
              threadTs: pending.slackThreadTs,
            });
          } else {
            await self.slack.postMessage(token, {
              channel: pending.slackChannel,
              text: input.message,
              threadTs: pending.slackThreadTs,
            });
          }
        } catch (err) {
          return errorResult(
            err instanceof Error
              ? `Slack post failed: ${err.message}`
              : "Slack post failed"
          );
        }
        // Move the question back to pending so the next reply in this thread
        // routes back to us. Without this, the SlackEventHandler ignores
        // replies on threads with status="answered".
        await self.prisma.client.slackPendingQuestion.update({
          where: { id: input.request_id },
          data: { status: "pending" },
        });
        return ok(
          `Follow-up${file ? ` (with ${file.filename})` : ""} posted in the Slack thread (request_id=${input.request_id}). Their next reply will come back as a new message in this chat.`
        );
      },
    };
  }

  private buildConcludeTool(scope: {
    workspaceId: string;
    envId: string;
    sessionId: string;
  }): McpToolDescriptor<typeof SLACK_CONCLUDE_SHAPE> {
    const self = this;
    return {
      name: "slack_conclude",
      description:
        "Wrap up a `slack_ask` conversation. Marks the thread concluded, posts a short closing summary back to Slack (so the recipient knows you're done), and tells the WithVibe UI to collapse the intermediate Slack-reply cards into a single conclusion. Optionally attach a file from the env via `file_path` (e.g. the resulting artifact). Call this once you have what you need from the Slack conversation — your normal text response in this chat is the conclusion the asker will see.",
      inputShape: SLACK_CONCLUDE_SHAPE,
      async handler(raw) {
        const input = z.object(SLACK_CONCLUDE_SHAPE).parse(raw);
        const pending =
          await self.prisma.client.slackPendingQuestion.findUnique({
            where: { id: input.request_id },
            select: {
              workspaceId: true,
              chatSessionId: true,
              slackChannel: true,
              slackThreadTs: true,
              concludedAt: true,
            },
          });
        if (!pending) {
          return errorResult(
            `No Slack thread found for request_id=${input.request_id}.`
          );
        }
        if (
          pending.workspaceId !== scope.workspaceId ||
          pending.chatSessionId !== scope.sessionId
        ) {
          return errorResult(
            "This request_id belongs to a different session/workspace."
          );
        }
        if (pending.concludedAt) {
          return errorResult(
            "This Slack thread is already concluded."
          );
        }
        const token = await self.requireBotToken(scope.workspaceId);
        if (typeof token !== "string") return token;
        const file = await self.maybeResolveFile({
          workspaceId: scope.workspaceId,
          envId: scope.envId,
          filePath: input.file_path,
        });
        if (file && !file.ok) return file.error;
        const closingText = `:white_check_mark: *Thanks — wrapping up here.*\n\n${input.summary}`;
        try {
          if (file) {
            await self.slack.uploadFile(token, {
              channel: pending.slackChannel,
              file: file.buffer,
              filename: file.filename,
              initialComment: closingText,
              threadTs: pending.slackThreadTs,
            });
          } else {
            await self.slack.postMessage(token, {
              channel: pending.slackChannel,
              text: closingText,
              threadTs: pending.slackThreadTs,
            });
          }
        } catch (err) {
          return errorResult(
            err instanceof Error
              ? `Slack post failed: ${err.message}`
              : "Slack post failed"
          );
        }
        await self.prisma.client.slackPendingQuestion.update({
          where: { id: input.request_id },
          data: {
            status: "answered",
            concludedAt: new Date(),
            summary: input.summary,
          },
        });
        return ok(
          `Slack thread concluded${file ? ` (with ${file.filename})` : ""} (request_id=${input.request_id}). The intermediate Slack-reply cards in this chat will collapse; the asker will see your text response as the conclusion.`
        );
      },
    };
  }

  /**
   * Read a file from the env's working directory for upload. Returns `null`
   * when no `file_path` was requested (no-op for non-file tool calls).
   * Otherwise: validates the path is inside the env dir (no `..` escapes,
   * no absolute paths) and below the size cap, then returns its buffer
   * + basename. Errors come back as a CallToolResult so handlers can
   * `return file.error` directly.
   */
  private async maybeResolveFile(opts: {
    workspaceId: string;
    envId: string | null;
    filePath: string | undefined;
  }): Promise<
    | null
    | { ok: true; buffer: Buffer; filename: string }
    | { ok: false; error: CallToolResult }
  > {
    if (!opts.filePath) return null;
    if (!opts.envId) {
      return {
        ok: false,
        error: errorResult(
          "Cannot attach a file: this tool is running without an env context."
        ),
      };
    }
    const envDir = this.envClones.envDir(opts.workspaceId, opts.envId);
    // Strip a leading slash to be friendly — the agent may use absolute-ish
    // paths against its cwd. Then normalize and ensure the result stays
    // inside envDir.
    const rel = path.normalize(opts.filePath.replace(/^[\\/]+/, ""));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        ok: false,
        error: errorResult(
          `file_path '${opts.filePath}' escapes the env directory. Use a path inside the env.`
        ),
      };
    }
    const absPath = path.resolve(envDir, rel);
    if (absPath !== envDir && !absPath.startsWith(envDir + path.sep)) {
      return {
        ok: false,
        error: errorResult(
          `file_path '${opts.filePath}' resolves outside the env directory.`
        ),
      };
    }
    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch {
      return {
        ok: false,
        error: errorResult(`File not found: ${opts.filePath}`),
      };
    }
    if (!stat.isFile()) {
      return {
        ok: false,
        error: errorResult(`Not a file: ${opts.filePath}`),
      };
    }
    if (stat.size > MAX_SLACK_UPLOAD_BYTES) {
      return {
        ok: false,
        error: errorResult(
          `File too large: ${stat.size} bytes exceeds the ${Math.round(MAX_SLACK_UPLOAD_BYTES / 1024 / 1024)}MB cap.`
        ),
      };
    }
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absPath);
    } catch (err) {
      return {
        ok: false,
        error: errorResult(
          `Failed to read file '${opts.filePath}': ${err instanceof Error ? err.message : String(err)}`
        ),
      };
    }
    return { ok: true, buffer, filename: path.basename(rel) };
  }

  private async resolveTarget(
    workspaceId: string,
    input: { channel?: string; member_email?: string }
  ): Promise<TargetResult> {
    if (!input.channel && !input.member_email) {
      return {
        ok: false,
        error: errorResult("Provide either `channel` or `member_email`."),
      };
    }
    if (input.channel && input.member_email) {
      return {
        ok: false,
        error: errorResult(
          "Provide either `channel` or `member_email`, not both."
        ),
      };
    }
    if (input.member_email) {
      const slackUserId = await this.slack.resolveSlackUserByEmail({
        workspaceId,
        email: input.member_email,
      });
      if (!slackUserId) {
        return {
          ok: false,
          error: errorResult(
            `No Slack user found for ${input.member_email}. They may not be in this Slack workspace, or their Slack email doesn't match.`
          ),
        };
      }
      return {
        ok: true,
        target: {
          kind: "dm",
          channel: slackUserId,
          label: `DM to ${input.member_email}`,
        },
      };
    }
    const channel = input.channel!.replace(/^#/, "");
    return {
      ok: true,
      target: { kind: "channel", channel, label: `channel ${input.channel}` },
    };
  }

  private async requireBotToken(
    workspaceId: string
  ): Promise<string | CallToolResult> {
    const ws = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { slackBotToken: true },
    });
    if (!ws?.slackBotToken) {
      return errorResult(
        "Slack is not connected for this workspace. Ask an admin to set it up in Settings → Communication."
      );
    }
    return ws.slackBotToken;
  }
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
