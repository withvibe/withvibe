import { Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { mkdir, readFile, writeFile, access } from "fs/promises";
import * as path from "node:path";
import { EnvCloneService } from "../env-clones/env-clone.service";
import { PrismaService } from "../prisma/prisma.service";
import type {
  McpServerSpec,
  McpToolDescriptor,
} from "../mcp-bridge/mcp-tool-types";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";

const RENDER_PDF_SHAPE = {
  sourcePath: z
    .string()
    .min(1)
    .describe(
      'Relative path (from env root) to the markdown source, e.g. "./extracontext/ai/docs/architecture.md". Must point inside ./extracontext/.'
    ),
  outputPath: z
    .string()
    .min(1)
    .describe(
      'Relative path (from env root) where the PDF should be written, e.g. "./extracontext/ai/docs/architecture.pdf". Must end in .pdf and live inside ./extracontext/. By convention put deliverables under ./extracontext/ai/.'
    ),
};

const DESCRIPTION = `Render a markdown file under \`./extracontext/\` to PDF, also under \`./extracontext/\`.

Workflow: \`Write\` your markdown to e.g. \`./extracontext/ai/docs/architecture.md\`, then call this with \`sourcePath\` pointing at it and \`outputPath\` ending in \`.pdf\`. Both paths must live inside \`./extracontext/\` — the tool will refuse paths outside that folder. By convention put AI deliverables under \`./extracontext/ai/\`.

The user-facing Extra Context tab will show the PDF for download. Keep the source \`.md\` next to the PDF (don't delete it) — the user may want both.`;

/**
 * MCP server exposing markdown→PDF rendering for the env's `extracontext/`
 * tree. Path-jail enforced: both source and output must resolve inside
 * `<envDir>/extracontext/`. Rendering is server-side via `md-to-pdf`
 * (puppeteer/Chromium under the hood). By convention agents put deliverables
 * under `extracontext/ai/`, but the jail allows any sub-path of extracontext/
 * for cases where the user explicitly asks for a specific named folder.
 */
@Injectable()
export class ExternalContextMcpService {
  constructor(
    @InjectPinoLogger(ExternalContextMcpService.name)
    private readonly logger: PinoLogger,
    private readonly prisma: PrismaService,
    private readonly envClones: EnvCloneService
  ) {}

  describeMcpServer(workspaceId: string, envId: string): McpServerSpec {
    const self = this;
    const envDir = this.envClones.envDir(workspaceId, envId);
    const extraContextDir = path.join(envDir, "extracontext");

    function resolveInsideExtraContext(rel: string): string | null {
      // Strip any leading "./" and normalize. Reject absolute paths.
      if (path.isAbsolute(rel)) return null;
      const cleaned = rel.replace(/^\.\/+/, "");
      const target = path.resolve(envDir, cleaned);
      const root = path.resolve(extraContextDir);
      if (target !== root && !target.startsWith(root + path.sep)) return null;
      return target;
    }

    const renderPdf: McpToolDescriptor<typeof RENDER_PDF_SHAPE> = {
      name: "render_pdf",
      description: DESCRIPTION,
      inputShape: RENDER_PDF_SHAPE,
      async handler(raw) {
        const input = z.object(RENDER_PDF_SHAPE).parse(raw);
        const sourceAbs = resolveInsideExtraContext(input.sourcePath);
        const outputAbs = resolveInsideExtraContext(input.outputPath);
        if (!sourceAbs || !outputAbs) {
          return {
            content: [
              {
                type: "text" as const,
                text: "render_pdf rejected: both sourcePath and outputPath must be relative paths inside ./extracontext/.",
              },
            ],
            isError: true,
          };
        }
        if (!outputAbs.toLowerCase().endsWith(".pdf")) {
          return {
            content: [
              {
                type: "text" as const,
                text: "render_pdf rejected: outputPath must end in .pdf.",
              },
            ],
            isError: true,
          };
        }

        try {
          await access(sourceAbs);
        } catch {
          return {
            content: [
              {
                type: "text" as const,
                text: `render_pdf failed: source markdown not found at ${input.sourcePath}. Write the .md file first, then call render_pdf.`,
              },
            ],
            isError: true,
          };
        }

        try {
          const md = await readFile(sourceAbs, "utf8");
          await mkdir(path.dirname(outputAbs), { recursive: true });
          // Lazy import — pulls in puppeteer + Chromium and adds ~1s to cold
          // start. Only paid the first time render_pdf is invoked in a process.
          const { mdToPdf } = await import("md-to-pdf");
          const result = await mdToPdf(
            { content: md },
            { dest: outputAbs, launch_options: { args: ["--no-sandbox"] } }
          );
          if (!result || !result.content) {
            throw new Error("md-to-pdf returned empty result");
          }
          // mdToPdf writes via dest, but in case it didn't (some versions
          // require an explicit write), fall back to writing the buffer.
          try {
            await access(outputAbs);
          } catch {
            await writeFile(outputAbs, result.content);
          }
          self.logger.info(
            `[external-context-mcp] render_pdf env=${envId} ${input.sourcePath} -> ${input.outputPath}`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `Rendered ${input.sourcePath} → ${input.outputPath}. The user can now download it from the Extra Context tab.`,
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          self.logger.error(
            `[external-context-mcp] render_pdf env=${envId} failed: ${msg}`
          );
          return {
            content: [
              {
                type: "text" as const,
                text: `render_pdf failed: ${msg}. The .md source is still on disk; the user can download it as markdown from the Extra Context tab.`,
              },
            ],
            isError: true,
          };
        }
      },
    };

    return {
      name: "withvibe-external-context",
      version: "1.0.0",
      tools: [renderPdf],
    };
  }

  createMcpServer(
    workspaceId: string,
    envId: string
  ): McpSdkServerConfigWithInstance {
    const spec = this.describeMcpServer(workspaceId, envId);
    return createSdkMcpServer({
      name: spec.name,
      version: spec.version,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.inputShape, t.handler)
      ),
    });
  }
}
