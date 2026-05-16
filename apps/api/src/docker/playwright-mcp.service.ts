import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import type {
  McpServerSpec,
  McpToolDescriptor,
} from "../mcp-bridge/mcp-tool-types";
import { PrismaService } from "../prisma/prisma.service";
import { BrowserSidecarService } from "./browser-sidecar.service";
import { UserBrowserBridgeService } from "./user-browser.service";
import type { BrowserOps } from "./qa-browser-ops";

type Connection = {
  cdpEndpoint: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

const NAVIGATE_SHAPE = {
  url: z.string().describe("Absolute URL to navigate to (http:// or https://)."),
  waitUntil: z
    .enum(["load", "domcontentloaded", "networkidle"])
    .optional()
    .describe(
      "When to consider navigation finished. Default 'domcontentloaded'. Use 'networkidle' for SPAs that fetch on mount."
    ),
};

const CLICK_SHAPE = {
  selector: z
    .string()
    .describe(
      "Playwright selector — CSS, `text=Some text`, `role=button[name=\"Save\"]`, `[data-testid=login]`, etc. Prefer role-based and text selectors over brittle CSS."
    ),
  timeoutMs: z
    .number()
    .int()
    .min(500)
    .max(30000)
    .optional()
    .describe("Max wait for element to be actionable. Default 5000."),
};

const FILL_SHAPE = {
  selector: z.string().describe("Playwright selector for the input element."),
  value: z.string().describe("Text to type into the field."),
  timeoutMs: z.number().int().min(500).max(30000).optional(),
};

const PRESS_SHAPE = {
  selector: z.string().describe("Playwright selector for the focus target."),
  key: z
    .string()
    .describe(
      "Key name — e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown', 'Control+A'."
    ),
};

const WAIT_SHAPE = {
  selector: z.string().describe("Playwright selector to wait for."),
  state: z
    .enum(["attached", "detached", "visible", "hidden"])
    .optional()
    .describe("Default 'visible'."),
  timeoutMs: z
    .number()
    .int()
    .min(500)
    .max(60000)
    .optional()
    .describe("Default 10000."),
};

const SCREENSHOT_SHAPE = {
  fullPage: z
    .boolean()
    .optional()
    .describe("Capture the full scrollable page. Default false (viewport only)."),
};

const EVAL_SHAPE = {
  expression: z
    .string()
    .describe(
      "JavaScript expression evaluated in the page context. Use a function body or arrow expression. Avoid side effects beyond what you'd do in a real test."
    ),
};

const TEXT_SHAPE = {
  selector: z
    .string()
    .describe("Playwright selector for the element whose text you want."),
};

/**
 * In-process MCP server exposing browser-driving tools. Dispatches each call
 * to a `BrowserOps` chosen at the start of the tool call:
 *  - `qaBrowserMode === "sidecar"`: connects to the env's headed Chromium
 *    Docker sidecar over CDP and uses Playwright in-process.
 *  - `qaBrowserMode === "user_browser"`: forwards the call to the user's
 *    paired Chrome extension over the WebSocket bridge.
 *
 * Per-env Playwright connection cache: one Browser/Context/Page per envId.
 * The page is created on first connect and reused across tool calls.
 */
@Injectable()
export class PlaywrightMcpService {
  private readonly logger = new Logger(PlaywrightMcpService.name);
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sidecar: BrowserSidecarService,
    private readonly userBrowser: UserBrowserBridgeService
  ) {}

  async closeForEnv(envId: string): Promise<void> {
    const conn = this.connections.get(envId);
    if (!conn) return;
    this.connections.delete(envId);
    try {
      await conn.browser.close();
    } catch (err) {
      this.logger.warn(
        `closeForEnv(${envId}): browser.close() failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Pick the right transport for this env. Resolves on every tool call so a
   * runtime mode change (or extension reconnect) is picked up without
   * tearing down the chat session.
   */
  private async opsFor(args: {
    envId: string;
    userId: string;
  }): Promise<BrowserOps> {
    const env = await this.prisma.client.env.findUnique({
      where: { id: args.envId },
      select: { qaBrowserMode: true },
    });
    if (env?.qaBrowserMode === "user_browser") {
      return this.userBrowser.opsFor({
        envId: args.envId,
        userId: args.userId,
      });
    }
    return this.sidecarOpsFor(args.envId);
  }

  private async sidecarOpsFor(envId: string): Promise<BrowserOps> {
    const getPage = () => this.getPage(envId);
    return {
      async navigate(args) {
        const page = await getPage();
        await page.goto(args.url, {
          waitUntil: args.waitUntil ?? "domcontentloaded",
          timeout: 30_000,
        });
        return { url: page.url(), title: await page.title() };
      },
      async click(args) {
        const page = await getPage();
        await page.click(args.selector, {
          timeout: args.timeoutMs ?? 5000,
        });
        return { url: page.url() };
      },
      async fill(args) {
        const page = await getPage();
        await page.fill(args.selector, args.value, {
          timeout: args.timeoutMs ?? 5000,
        });
      },
      async press(args) {
        const page = await getPage();
        await page.press(args.selector, args.key);
      },
      async waitFor(args) {
        const page = await getPage();
        await page.waitForSelector(args.selector, {
          state: args.state ?? "visible",
          timeout: args.timeoutMs ?? 10_000,
        });
      },
      async snapshot() {
        const page = await getPage();
        const yaml = await page.locator("body").ariaSnapshot();
        return {
          url: page.url(),
          title: await page.title(),
          ariaTreeYaml: yaml,
        };
      },
      async screenshot(args) {
        const page = await getPage();
        const buf = await page.screenshot({
          fullPage: args.fullPage ?? false,
          type: "png",
        });
        return { pngBase64: buf.toString("base64") };
      },
      async evaluate(args) {
        const page = await getPage();
        return await page.evaluate(args.expression);
      },
      async currentState() {
        const page = await getPage();
        return { url: page.url(), title: await page.title() };
      },
      async goBack() {
        const page = await getPage();
        await page.goBack();
        return { url: page.url() };
      },
      async reload() {
        const page = await getPage();
        await page.reload({ waitUntil: "domcontentloaded" });
        return { url: page.url() };
      },
      async textContent(args) {
        const page = await getPage();
        return await page.textContent(args.selector, { timeout: 5000 });
      },
    };
  }

  private async getPage(envId: string): Promise<Page> {
    const cdp = await this.sidecar.getCdpEndpoint(envId);
    if (!cdp) {
      throw new Error(
        "QA browser sidecar is not running for this env. Start it from the QA Browser tab, or switch this env's QA browser mode to 'user_browser'."
      );
    }
    const cached = this.connections.get(envId);
    if (cached && cached.cdpEndpoint === cdp && cached.browser.isConnected()) {
      return cached.page;
    }
    if (cached) {
      try {
        await cached.browser.close();
      } catch {
        // best-effort
      }
      this.connections.delete(envId);
    }

    const browser = await chromium.connectOverCDP(cdp);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    this.connections.set(envId, { cdpEndpoint: cdp, browser, context, page });
    return page;
  }

  describeMcpServer(args: { envId: string; userId: string }): McpServerSpec {
    const self = this;
    const { envId, userId } = args;

    const navigate: McpToolDescriptor<typeof NAVIGATE_SHAPE> = {
      name: "navigate",
      description:
        "Navigate the QA browser to a URL. The user watches this happen live in the QA Browser tab. Use this at the start of each test step that begins on a different page.",
      inputShape: NAVIGATE_SHAPE,
      async handler(raw) {
        const input = z.object(NAVIGATE_SHAPE).parse(raw);
        const ops = await self.opsFor({ envId, userId });
        const r = await ops.navigate(input);
        return {
          content: [
            {
              type: "text" as const,
              text: `Navigated to ${r.url} (title: ${r.title}).`,
            },
          ],
        };
      },
    };

    const click: McpToolDescriptor<typeof CLICK_SHAPE> = {
      name: "click",
      description:
        "Click an element. Selector accepts CSS, `text=...`, `role=...`, etc. Always prefer role/text selectors over CSS chains. Will wait for the element to be actionable.",
      inputShape: CLICK_SHAPE,
      async handler(raw) {
        const input = z.object(CLICK_SHAPE).parse(raw);
        const ops = await self.opsFor({ envId, userId });
        const r = await ops.click(input);
        return {
          content: [
            {
              type: "text" as const,
              text: `Clicked ${JSON.stringify(input.selector)}. Current URL: ${r.url}`,
            },
          ],
        };
      },
    };

    const fill: McpToolDescriptor<typeof FILL_SHAPE> = {
      name: "fill",
      description:
        "Type a value into an input. Clears existing content first. For non-text inputs (checkbox, radio, select) use `click` instead.",
      inputShape: FILL_SHAPE,
      async handler(raw) {
        const input = z.object(FILL_SHAPE).parse(raw);
        const ops = await self.opsFor({ envId, userId });
        await ops.fill(input);
        return {
          content: [
            {
              type: "text" as const,
              text: `Filled ${JSON.stringify(input.selector)} with ${JSON.stringify(input.value)}.`,
            },
          ],
        };
      },
    };

    const press: McpToolDescriptor<typeof PRESS_SHAPE> = {
      name: "press",
      description:
        "Press a keyboard key on an element (focuses it first). Use for Enter, Escape, Tab, arrow keys, or chords like Control+A.",
      inputShape: PRESS_SHAPE,
      async handler(raw) {
        const input = z.object(PRESS_SHAPE).parse(raw);
        const ops = await self.opsFor({ envId, userId });
        await ops.press(input);
        return {
          content: [
            {
              type: "text" as const,
              text: `Pressed ${input.key} on ${JSON.stringify(input.selector)}.`,
            },
          ],
        };
      },
    };

    const waitFor: McpToolDescriptor<typeof WAIT_SHAPE> = {
      name: "wait_for",
      description:
        "Wait for an element to reach a state (visible by default). Use this before asserting on async UI — never click and check immediately.",
      inputShape: WAIT_SHAPE,
      async handler(raw) {
        const input = z.object(WAIT_SHAPE).parse(raw);
        const ops = await self.opsFor({ envId, userId });
        await ops.waitFor(input);
        return {
          content: [
            {
              type: "text" as const,
              text: `${JSON.stringify(input.selector)} is now ${input.state ?? "visible"}.`,
            },
          ],
        };
      },
    };

    const snapshot: McpToolDescriptor<Record<string, never>> = {
      name: "snapshot",
      description:
        "Return the page's accessibility tree as JSON — structured, deterministic, token-efficient. PREFER this over `screenshot` for assertions; reach for screenshots only when you need pixel evidence for a bug report or visual layout check.",
      inputShape: {} as Record<string, never>,
      async handler() {
        const ops = await self.opsFor({ envId, userId });
        const r = await ops.snapshot();
        return {
          content: [
            {
              type: "text" as const,
              text: `URL: ${r.url}\nTitle: ${r.title}\n\nA11y tree (YAML):\n${r.ariaTreeYaml}`,
            },
          ],
        };
      },
    };

    const screenshot: McpToolDescriptor<typeof SCREENSHOT_SHAPE> = {
      name: "screenshot",
      description:
        "Capture a PNG screenshot of the current page. Returns base64-encoded image data. Use sparingly — prefer `snapshot` for assertions. Reach for this when you need pixel evidence for a bug report or to verify visual layout.",
      inputShape: SCREENSHOT_SHAPE,
      async handler(raw) {
        const input = z.object(SCREENSHOT_SHAPE).parse(raw);
        const ops = await self.opsFor({ envId, userId });
        const r = await ops.screenshot(input);
        return {
          content: [
            {
              type: "image" as const,
              data: r.pngBase64,
              mimeType: "image/png",
            },
          ],
        };
      },
    };

    const evaluate: McpToolDescriptor<typeof EVAL_SHAPE> = {
      name: "evaluate",
      description:
        "Run a JavaScript expression in the page context and return its result. Use for last-resort assertions when the a11y tree doesn't surface what you need (e.g. reading `localStorage`, computing a value, inspecting non-semantic DOM).",
      inputShape: EVAL_SHAPE,
      async handler(raw) {
        const input = z.object(EVAL_SHAPE).parse(raw);
        const ops = await self.opsFor({ envId, userId });
        const result = await ops.evaluate(input);
        return {
          content: [
            {
              type: "text" as const,
              text: `Result: ${JSON.stringify(result)}`,
            },
          ],
        };
      },
    };

    const currentState: McpToolDescriptor<Record<string, never>> = {
      name: "current_state",
      description:
        "Return the current URL and page title — a cheap orienting check between actions.",
      inputShape: {} as Record<string, never>,
      async handler() {
        const ops = await self.opsFor({ envId, userId });
        const r = await ops.currentState();
        return {
          content: [
            {
              type: "text" as const,
              text: `URL: ${r.url}\nTitle: ${r.title}`,
            },
          ],
        };
      },
    };

    const goBack: McpToolDescriptor<Record<string, never>> = {
      name: "go_back",
      description: "Navigate back in browser history (same as the back button).",
      inputShape: {} as Record<string, never>,
      async handler() {
        const ops = await self.opsFor({ envId, userId });
        const r = await ops.goBack();
        return {
          content: [
            { type: "text" as const, text: `Back. URL: ${r.url}` },
          ],
        };
      },
    };

    const reload: McpToolDescriptor<Record<string, never>> = {
      name: "reload",
      description: "Reload the current page (hard reload).",
      inputShape: {} as Record<string, never>,
      async handler() {
        const ops = await self.opsFor({ envId, userId });
        const r = await ops.reload();
        return {
          content: [
            { type: "text" as const, text: `Reloaded. URL: ${r.url}` },
          ],
        };
      },
    };

    const textContent: McpToolDescriptor<typeof TEXT_SHAPE> = {
      name: "text_content",
      description:
        "Return the text content of an element. Use for asserting on specific copy when the a11y tree is too noisy.",
      inputShape: TEXT_SHAPE,
      async handler(raw) {
        const input = z.object(TEXT_SHAPE).parse(raw);
        const ops = await self.opsFor({ envId, userId });
        const text = await ops.textContent(input);
        return {
          content: [
            {
              type: "text" as const,
              text: text === null ? "(element not found)" : text,
            },
          ],
        };
      },
    };

    return {
      name: "withvibe-browser",
      version: "1.0.0",
      tools: [
        navigate,
        click,
        fill,
        press,
        waitFor,
        snapshot,
        screenshot,
        evaluate,
        currentState,
        goBack,
        reload,
        textContent,
      ],
    };
  }

  createMcpServer(args: {
    envId: string;
    userId: string;
  }): McpSdkServerConfigWithInstance {
    const spec = this.describeMcpServer(args);
    return createSdkMcpServer({
      name: spec.name,
      version: spec.version,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.inputShape, t.handler)
      ),
    });
  }

  /** Tool names (with the `mcp__withvibe-browser__` prefix) for allowlisting. */
  allowedToolNames(): string[] {
    return [
      "mcp__withvibe-browser__navigate",
      "mcp__withvibe-browser__click",
      "mcp__withvibe-browser__fill",
      "mcp__withvibe-browser__press",
      "mcp__withvibe-browser__wait_for",
      "mcp__withvibe-browser__snapshot",
      "mcp__withvibe-browser__screenshot",
      "mcp__withvibe-browser__evaluate",
      "mcp__withvibe-browser__current_state",
      "mcp__withvibe-browser__go_back",
      "mcp__withvibe-browser__reload",
      "mcp__withvibe-browser__text_content",
    ];
  }
}
