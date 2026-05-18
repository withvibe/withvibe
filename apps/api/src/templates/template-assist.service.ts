import { Injectable, Logger } from "@nestjs/common";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { PrismaService } from "../prisma/prisma.service";
import { WorkspaceAccessService } from "../common/workspace-access.service";

/**
 * AI assistant for the template editor. Uses the Claude Agent SDK so that
 * Pro/Max OAuth tokens (sk-ant-oat) work natively — the agent SDK handles
 * the auth handshake and rate-limit semantics that the raw API rejects with
 * 429s when called directly with OAuth credentials.
 *
 * Tool calls aren't real Anthropic tools (the agent SDK is built around its
 * own filesystem/bash tools and doesn't cleanly expose custom UI-mediated
 * tools). Instead, the model writes edits as fenced code blocks:
 *
 *     ```withvibe-edit
 *     { "tool": "patchComposeFile", "input": { ... } }
 *     ```
 *
 * A streaming parser intercepts those blocks, validates the JSON, and
 * forwards them as the same `tool_use` SSE events the frontend already
 * understands. The block text itself is not echoed to the UI — only the
 * resulting diff card.
 */

export type AssistMessage = {
  role: "user" | "assistant";
  content: string;
};

export type TemplateState = {
  slug?: string;
  name?: string;
  description?: string;
  composeFile: string;
  variables: Array<Record<string, unknown>>;
  assets: Array<{ path: string; content: string; isTemplate: boolean }>;
  services: Array<Record<string, unknown>>;
  routingMode: "port" | "subdomain";
  routingBaseDomain: string;
  agentInstructions: string;
};

export type AssistRequest = {
  messages: AssistMessage[];
  templateState: TemplateState;
};

const MODEL = "claude-sonnet-4-6";

const TOOL_NAMES = [
  "setComposeFile",
  "patchComposeFile",
  "setAgentInstructions",
  "addVariable",
  "updateVariable",
  "removeVariable",
  "setService",
  "writeAsset",
  "removeAsset",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const SYSTEM_PROMPT = `You are an AI assistant embedded in the template editor of a docker-compose-based dev environment platform. The user is authoring an "env template" — a docker-compose stack plus declared variables, assets (extra files), and per-service notes.

Your job: help the user design and refine their template. You can either chat (explain, suggest, answer) or propose edits.

You DO NOT have filesystem, shell, web, or any external tools. Do not attempt to use Bash, Read, Write, Edit, or any built-in tool. Your only way to change the template is to emit edit proposals in plain text using the format below.

## How to propose edits

Write a fenced code block with the language tag \`withvibe-edit\` containing exactly one JSON object:

\`\`\`withvibe-edit
{ "tool": "<toolName>", "input": { ... } }
\`\`\`

The UI parses these blocks out of your response and renders them as diff cards the user can accept or reject. The block text itself is not shown — the user sees a structured preview. Always explain the change in plain prose AROUND the block (the prose IS shown).

## Available tools

### setComposeFile
Replace the entire docker-compose.yml. Use only for blank-state authoring or major restructuring; otherwise prefer patchComposeFile.
Input: \`{ "content": "<full new compose YAML>" }\`

### patchComposeFile
Replace an exact substring of the current compose file. Fails if oldString is not unique. Prefer this for targeted edits.
Input: \`{ "oldString": "<exact substring>", "newString": "<replacement>" }\`

### setAgentInstructions
Set the template-wide free-text instructions for the DevOps agent that materializes envs.
Input: \`{ "content": "<instructions, or empty string to clear>" }\`

### addVariable
Add a new template variable. Key must be UPPER_SNAKE_CASE.
Input: \`{ "key": "MY_VAR", "kind": "system-port|user-input|secret|default|service-url", "label"?: "...", "description"?: "...", "defaultValue"?: "...", "required"?: true, "secretName"?: "...", "service"?: "...", "portKey"?: "..." }\`

### updateVariable
Patch an existing variable.
Input: \`{ "key": "MY_VAR", "patch": { "<field>": "<value-or-null-to-clear>" } }\`

### removeVariable
Input: \`{ "key": "MY_VAR" }\`

### setService
Set notes for a compose service (must already exist in the compose file).
Input: \`{ "name": "<service>", "description"?: "...", "role"?: "...", "userFacing"?: true, "agentInstructions"?: "..." }\`

### writeAsset
Create or overwrite an asset file. Path is relative to the env dir, no leading slash, no "..".
Input: \`{ "path": "nginx/conf.d/default.conf", "content": "...", "isTemplate"?: true }\`

### removeAsset
Input: \`{ "path": "<path>" }\`

## Variable kinds reference

- "system-port" — orchestrator allocates a unique host port per env. Use for any variable that maps to a docker host port.
- "user-input" — collected from the end-user on the create-env form.
- "secret" — pulled from the workspace secret store (secretName).
- "default" — static value baked into the template.
- "service-url" — resolves to the URL of another service. Subdomain mode → http://<service>-<id>.<baseDomain>. Port mode → http://host:<portKey value>.

Variable keys are UPPER_SNAKE_CASE. Reference them in compose with \${KEY}.

## Conventions

- Be concise. Don't restate what the user said.
- Prefer patchComposeFile over setComposeFile for surgical changes.
- Always explain *why* you're making a change in prose before the edit block.
- One tool per code block. Multiple blocks in one response is fine.
- Never invent service names or paths the user didn't ask about.
- If the user asks a question that doesn't require an edit, just answer in prose.
- The full JSON object must be valid JSON — escape strings, no trailing commas, no comments.`;

@Injectable()
export class TemplateAssistService {
  private readonly logger = new Logger(TemplateAssistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: WorkspaceAccessService
  ) {}

  async assist(
    userId: string,
    workspaceId: string,
    body: AssistRequest
  ): Promise<ReadableStream<Uint8Array>> {
    await this.access.admin(userId, workspaceId);

    const workspace = await this.prisma.client.workspace.findUnique({
      where: { id: workspaceId },
      select: { anthropicApiKey: true },
    });
    const credential = workspace?.anthropicApiKey;
    if (!credential) {
      throw new Error(
        "No Anthropic credential configured for this workspace. Set one in Settings → AI."
      );
    }
    const isOAuth = credential.startsWith("sk-ant-oat");
    const masked = credential.slice(0, 12) + "…" + credential.slice(-4);
    this.logger.log(
      `Template assist using credential from workspace (${masked}, kind=${isOAuth ? "oauth" : "api-key"})`
    );

    // Route the credential by format. The Agent SDK reads these env vars:
    //   sk-ant-oat* → CLAUDE_CODE_OAUTH_TOKEN (Max/Pro subscription)
    //   sk-ant-api* → ANTHROPIC_API_KEY (standard API billing)
    const env: Record<string, string | undefined> = { ...process.env };
    if (isOAuth) {
      env.CLAUDE_CODE_OAUTH_TOKEN = credential;
      delete env.ANTHROPIC_API_KEY;
    } else {
      env.ANTHROPIC_API_KEY = credential;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }

    const messages = this.normalizeMessages(body.messages);
    if (messages.length === 0) {
      throw new Error("messages must contain at least one user turn");
    }

    const stateSnapshot = this.formatState(body.templateState);
    const prompt = this.buildPrompt(messages, stateSnapshot);

    const encoder = new TextEncoder();
    const sendEvent = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      event: Record<string, unknown>
    ) => {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    };

    const logger = this.logger;

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          sendEvent(controller, {
            type: "info",
            credentialSource: "workspace",
            credentialKind: isOAuth ? "oauth" : "api-key",
          });

          const q = query({
            prompt,
            options: {
              model: MODEL,
              systemPrompt: SYSTEM_PROMPT,
              env: env as Record<string, string>,
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              includePartialMessages: true,
              // Disable every built-in tool — this is a chat assistant, not
              // a coding agent. We don't want it touching the filesystem.
              disallowedTools: [
                "Bash",
                "BashOutput",
                "KillBash",
                "Read",
                "Write",
                "Edit",
                "MultiEdit",
                "NotebookEdit",
                "Glob",
                "Grep",
                "WebFetch",
                "WebSearch",
                "Task",
                "TodoWrite",
                "ExitPlanMode",
              ],
            },
          });

          const parser = new EditBlockParser((event) =>
            sendEvent(controller, event)
          );

          for await (const msg of q) {
            // Partial messages stream the underlying Anthropic events.
            if (msg.type === "stream_event") {
              const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
              if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                const text = ev.delta.text;
                if (typeof text === "string") parser.push(text);
              }
              continue;
            }
            if (msg.type === "assistant") {
              // Fallback for SDK builds that don't emit partial events for
              // some block types — push any text content we haven't seen.
              const content = (msg as { message?: { content?: unknown[] } })
                .message?.content;
              if (Array.isArray(content) && !parser.sawAnyDelta) {
                for (const block of content) {
                  const b = block as { type?: string; text?: string };
                  if (b.type === "text" && typeof b.text === "string") {
                    parser.push(b.text);
                  }
                }
              }
              continue;
            }
            if (msg.type === "result") {
              parser.flush();
              const result = msg as {
                subtype?: string;
                is_error?: boolean;
                result?: string;
              };
              if (result.is_error || result.subtype === "error_max_turns") {
                sendEvent(controller, {
                  type: "error",
                  message: result.result || "Assistant run failed",
                });
              }
              sendEvent(controller, { type: "done" });
              break;
            }
          }
          parser.flush();
          controller.close();
        } catch (err) {
          logger.error(`Assistant stream failed: ${err}`);
          sendEvent(controller, {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
          controller.close();
        }
      },
    });
  }

  /**
   * The agent SDK takes a single prompt string per query() call, not an
   * array of role-tagged messages. Stuff prior chat turns into the prompt
   * with role markers so the model has conversation context.
   */
  private buildPrompt(
    messages: AssistMessage[],
    stateSnapshot: string
  ): string {
    const last = messages[messages.length - 1];
    const history = messages.slice(0, -1);
    const historyBlock =
      history.length > 0
        ? [
            "Previous conversation:",
            ...history.map((m) =>
              `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content}`
            ),
            "",
          ].join("\n")
        : "";
    return [
      stateSnapshot,
      "",
      historyBlock,
      "Current user message:",
      last.content,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private normalizeMessages(raw: AssistMessage[]): AssistMessage[] {
    const out: AssistMessage[] = [];
    for (const m of raw) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const content = typeof m.content === "string" ? m.content.trim() : "";
      if (!content) continue;
      out.push({ role: m.role, content });
    }
    while (out.length > 0 && out[0].role !== "user") out.shift();
    const squashed: AssistMessage[] = [];
    for (const m of out) {
      const prev = squashed[squashed.length - 1];
      if (prev && prev.role === m.role) {
        prev.content = `${prev.content}\n\n${m.content}`;
      } else {
        squashed.push({ ...m });
      }
    }
    return squashed;
  }

  private formatState(state: TemplateState): string {
    const variables =
      (state.variables ?? [])
        .map((v) => `  - ${JSON.stringify(v)}`)
        .join("\n") || "  (none)";
    const services =
      (state.services ?? [])
        .map((s) => `  - ${JSON.stringify(s)}`)
        .join("\n") || "  (none)";
    const assets =
      (state.assets ?? [])
        .map(
          (a) =>
            `  - ${a.path}${a.isTemplate ? " [interpolated]" : ""} (${a.content.length} chars)`
        )
        .join("\n") || "  (none)";
    return [
      "Current template state (this is what's in the editor right now — your edits propose deltas to this):",
      "",
      `Slug: ${state.slug ?? ""}`,
      `Name: ${state.name ?? ""}`,
      `Description: ${state.description ?? ""}`,
      `Routing mode: ${state.routingMode}${state.routingBaseDomain ? ` (base domain: ${state.routingBaseDomain})` : ""}`,
      "",
      "Agent instructions:",
      state.agentInstructions || "  (none)",
      "",
      "docker-compose.yml:",
      "```yaml",
      state.composeFile || "(empty)",
      "```",
      "",
      "Variables:",
      variables,
      "",
      "Services:",
      services,
      "",
      "Assets:",
      assets,
    ].join("\n");
  }
}

const OPEN_FENCE = "```withvibe-edit";
const CLOSE_FENCE = "```";

/**
 * Streaming parser that splits the assistant's output text into:
 *   - "text_delta" events — prose the user reads
 *   - "tool_use" events — withvibe-edit blocks parsed into structured tool calls
 *
 * Buffers a small lookahead so partial-fence text doesn't leak into
 * `text_delta` events before we know whether it's the start of an edit
 * block. Robust to chunk boundaries falling anywhere in the markers.
 */
class EditBlockParser {
  private mode: "text" | "block" = "text";
  private buf = "";
  private blockBuf = "";
  private toolIdCounter = 0;
  sawAnyDelta = false;

  constructor(
    private readonly emit: (event: Record<string, unknown>) => void
  ) {}

  push(chunk: string) {
    if (chunk.length === 0) return;
    this.sawAnyDelta = true;
    this.buf += chunk;
    this.process();
  }

  flush() {
    if (this.mode === "text") {
      // Emit anything left in the buffer — a trailing partial fence isn't
      // going to materialize into a real block now.
      if (this.buf.length > 0) {
        this.emit({ type: "text_delta", text: this.buf });
        this.buf = "";
      }
    } else {
      // Unterminated block — surface the JSON we have, even if the model
      // forgot the closing fence.
      this.tryEmitTool(this.blockBuf);
      this.blockBuf = "";
      this.mode = "text";
    }
  }

  private process() {
    while (true) {
      if (this.mode === "text") {
        const idx = this.buf.indexOf(OPEN_FENCE);
        if (idx === -1) {
          // No open fence in buffer — but the tail might be a partial
          // fence. Hold back the last (OPEN_FENCE.length - 1) chars.
          const safeLen = Math.max(0, this.buf.length - (OPEN_FENCE.length - 1));
          if (safeLen > 0) {
            this.emit({ type: "text_delta", text: this.buf.slice(0, safeLen) });
            this.buf = this.buf.slice(safeLen);
          }
          return;
        }
        // Emit text up to the open fence, then enter block mode.
        if (idx > 0) {
          this.emit({ type: "text_delta", text: this.buf.slice(0, idx) });
        }
        // Skip the fence + (optional) trailing newline.
        let after = idx + OPEN_FENCE.length;
        if (this.buf[after] === "\n") after++;
        else if (this.buf[after] === "\r" && this.buf[after + 1] === "\n") after += 2;
        this.buf = this.buf.slice(after);
        this.mode = "block";
        continue;
      }
      // mode === "block": look for closing fence.
      const idx = this.buf.indexOf(CLOSE_FENCE);
      if (idx === -1) {
        // Hold back tail that might be a partial closing fence.
        const safeLen = Math.max(0, this.buf.length - (CLOSE_FENCE.length - 1));
        if (safeLen > 0) {
          this.blockBuf += this.buf.slice(0, safeLen);
          this.buf = this.buf.slice(safeLen);
        }
        return;
      }
      this.blockBuf += this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + CLOSE_FENCE.length);
      // Eat trailing newline so it doesn't appear as stray prose.
      if (this.buf[0] === "\n") this.buf = this.buf.slice(1);
      else if (this.buf[0] === "\r" && this.buf[1] === "\n") this.buf = this.buf.slice(2);
      this.tryEmitTool(this.blockBuf);
      this.blockBuf = "";
      this.mode = "text";
    }
  }

  private tryEmitTool(rawBody: string) {
    const trimmed = rawBody.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      this.emit({
        type: "text_delta",
        text: `\n\n[parse error in withvibe-edit block: ${
          err instanceof Error ? err.message : String(err)
        }]\n\n`,
      });
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as { tool?: unknown; input?: unknown };
    const name = typeof obj.tool === "string" ? obj.tool : "";
    if (!TOOL_NAMES.includes(name as ToolName)) {
      this.emit({
        type: "text_delta",
        text: `\n\n[unknown tool in withvibe-edit block: ${name}]\n\n`,
      });
      return;
    }
    const input =
      obj.input && typeof obj.input === "object"
        ? (obj.input as Record<string, unknown>)
        : {};
    this.toolIdCounter += 1;
    this.emit({
      type: "tool_use",
      id: `te_${Date.now()}_${this.toolIdCounter}`,
      name,
      input,
    });
  }
}
