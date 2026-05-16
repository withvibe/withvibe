import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { PrismaService } from "../prisma/prisma.service";
import { DockerService } from "./docker.service";
import type {
  McpServerSpec,
  McpToolDescriptor,
} from "../mcp-bridge/mcp-tool-types";

type EnvStatusRow = {
  containerStatus: string;
  containerError: string | null;
  containerPorts: unknown;
  lastContainerAt: Date | null;
};

const WAIT_SHAPE = {
  timeoutSec: z
    .number()
    .int()
    .min(5)
    .max(180)
    .optional()
    .describe(
      "Max seconds to block before returning current status. Defaults to 60. Cap is 180; call again if the stack is still transitional."
    ),
  targets: z
    .array(z.enum(["running", "error", "stopped"]))
    .optional()
    .describe(
      "Statuses that count as 'done polling'. Defaults to ['running', 'error']. Pass ['stopped'] after a stop_env call."
    ),
};

const LOGS_SHAPE = {
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(40000)
    .optional()
    .describe(
      "Maximum characters to return from the tail. Defaults to 8000. Bump up if the error looks truncated."
    ),
};

const DESCRIPTIONS = {
  start_env:
    "Start this env's docker-compose stack. Same action as the user clicking the **Start** button. Returns immediately — the actual start runs in the background and writes to the env's log buffer. Poll `get_env_status` to see when it's running or errored, and call `get_env_logs` to read what happened. Use this instead of running `docker compose up` via Bash — running compose directly will collide on host ports with the user's Start button.",
  stop_env:
    "Stop this env's docker-compose stack. Same as the **Stop** button. Runs `docker compose down --remove-orphans` under the hood. Returns immediately; the stop happens in the background.",
  rebuild_env:
    "Rebuild this env's stack — `docker compose down` then `up --build`. Same as the **Rebuild** button. Use when you've changed the compose file or a Dockerfile and need a fresh image. For source-only changes on a bind-mounted dev compose, the dev server auto-reloads and you don't need this.",
  get_env_status:
    "Return the current lifecycle status of this env's stack. Use this to know when start/stop/rebuild actually finished, and to see per-container state. Status values: `stopped` | `starting` | `building` | `running` | `stopping` | `error`.",
  wait_for_env_status:
    "Block server-side until this env's lifecycle status transitions into one of the target values (default: `running` or `error`), or until a timeout elapses. Use this after `start_env` / `rebuild_env` instead of busy-polling `get_env_status`.\n\nKeep `timeoutSec` modest (60–120s) and call this tool repeatedly — each call is one 'poll chunk'. Between calls, emit a short text update to the user (e.g. 'still building, 2 min elapsed') so they see progress. This is how you cover long builds (mvn package, npm install on cold start) inside a single chat turn.\n\n**There is no scheduler.** You cannot 'come back later' — everything must happen in this turn. If the status is still transitional after many polls, tell the user and stop; they can re-ask later.",
  get_env_logs:
    "Read the tail of this env's compose log buffer — the same logs streaming into the UI log panel right now. Use this after start_env / rebuild_env to see what actually happened, and to diagnose failures before calling rebuild_env again. Not useful for application-level logs once the stack is steady-state; for that, the user's UI log panel (or a fresh start) is the right tool.",
};

/**
 * MCP server exposing the env's docker-compose lifecycle to chat agents
 * (the built-in DevOps persona in particular). Every tool is a thin wrapper
 * around DockerService, so:
 *
 *   - logs flow through DockerService.pushLog → same log buffer the UI
 *     streams via SSE; the user sees exactly what the agent triggered.
 *   - the docker project name is identical to what Start / Stop / Rebuild
 *     buttons use, so parallel runs can't collide on host ports.
 *
 * The agent is meant to use these instead of shelling out to `docker compose`
 * via Bash. See the DevOps persona prompt in `_seed-data.ts`.
 */
@Injectable()
export class DockerMcpService {
  private readonly logger = new Logger(DockerMcpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly docker: DockerService
  ) {}

  describeMcpServer(envId: string): McpServerSpec {
    const self = this;
    const startEnv: McpToolDescriptor<Record<string, never>> = {
      name: "start_env",
      description: DESCRIPTIONS.start_env,
      inputShape: {} as Record<string, never>,
      async handler() {
        self.logger.log(`[docker-mcp] start_env(${envId})`);
        await self.docker.startEnvironment(envId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Start requested for env ${envId}. The stack is now coming up in the background. Poll get_env_status until it returns "running" or "error" — dev-style composes (bind-mounted source, first-run dep install) can take several minutes on cold start.`,
            },
          ],
        };
      },
    };

    const stopEnv: McpToolDescriptor<Record<string, never>> = {
      name: "stop_env",
      description: DESCRIPTIONS.stop_env,
      inputShape: {} as Record<string, never>,
      async handler() {
        self.logger.log(`[docker-mcp] stop_env(${envId})`);
        await self.docker.stopEnvironment(envId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Stop requested for env ${envId}. Poll get_env_status until it returns "stopped".`,
            },
          ],
        };
      },
    };

    const rebuildEnv: McpToolDescriptor<Record<string, never>> = {
      name: "rebuild_env",
      description: DESCRIPTIONS.rebuild_env,
      inputShape: {} as Record<string, never>,
      async handler() {
        self.logger.log(`[docker-mcp] rebuild_env(${envId})`);
        await self.docker.rebuildEnvironment(envId);
        return {
          content: [
            {
              type: "text" as const,
              text: `Rebuild requested for env ${envId}. Poll get_env_status until it returns "running" or "error".`,
            },
          ],
        };
      },
    };

    const getEnvStatus: McpToolDescriptor<Record<string, never>> = {
      name: "get_env_status",
      description: DESCRIPTIONS.get_env_status,
      inputShape: {} as Record<string, never>,
      async handler() {
        const env = (await self.prisma.client.env.findUnique({
          where: { id: envId },
          select: {
            containerStatus: true,
            containerError: true,
            containerPorts: true,
            lastContainerAt: true,
          },
        })) as EnvStatusRow | null;
        if (!env) {
          return {
            content: [{ type: "text" as const, text: `Env ${envId} not found.` }],
            isError: true,
          };
        }
        const { containers } = await self.docker.listEnvContainers(envId);
        const lines = [
          `status: ${env.containerStatus}`,
          env.containerError ? `error: ${env.containerError}` : null,
          env.containerPorts &&
          typeof env.containerPorts === "object" &&
          Object.keys(env.containerPorts).length > 0
            ? `published ports: ${JSON.stringify(env.containerPorts)}`
            : null,
          env.lastContainerAt
            ? `last lifecycle event: ${env.lastContainerAt.toISOString()}`
            : null,
          containers.length === 0
            ? `containers: (none)`
            : `containers:\n${containers
                .map((c) => `  - ${c.name} [${c.status}] image=${c.image}`)
                .join("\n")}`,
        ].filter(Boolean);
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      },
    };

    const waitForEnvStatus: McpToolDescriptor<typeof WAIT_SHAPE> = {
      name: "wait_for_env_status",
      description: DESCRIPTIONS.wait_for_env_status,
      inputShape: WAIT_SHAPE,
      async handler(raw) {
        const input = z.object(WAIT_SHAPE).parse(raw);
        const timeoutMs = (input.timeoutSec ?? 60) * 1000;
        const targets = new Set(input.targets ?? ["running", "error"]);
        const pollIntervalMs = 3000;
        const deadline = Date.now() + timeoutMs;
        let last: EnvStatusRow | null = null;
        while (Date.now() < deadline) {
          last = (await self.prisma.client.env.findUnique({
            where: { id: envId },
            select: {
              containerStatus: true,
              containerError: true,
              containerPorts: true,
              lastContainerAt: true,
            },
          })) as EnvStatusRow | null;
          if (!last) {
            return {
              content: [
                { type: "text" as const, text: `Env ${envId} not found.` },
              ],
              isError: true,
            };
          }
          if (targets.has(last.containerStatus)) {
            const parts = [
              `status: ${last.containerStatus}`,
              last.containerError ? `error: ${last.containerError}` : null,
              last.containerPorts &&
              typeof last.containerPorts === "object" &&
              Object.keys(last.containerPorts).length > 0
                ? `published ports: ${JSON.stringify(last.containerPorts)}`
                : null,
            ].filter(Boolean);
            return {
              content: [{ type: "text" as const, text: parts.join("\n") }],
            };
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                `timed out after ${Math.round(timeoutMs / 1000)}s\n` +
                `current status: ${last?.containerStatus ?? "unknown"}\n` +
                `Call wait_for_env_status again to keep polling, or get_env_logs to see what compose is doing.`,
            },
          ],
        };
      },
    };

    const getEnvLogs: McpToolDescriptor<typeof LOGS_SHAPE> = {
      name: "get_env_logs",
      description: DESCRIPTIONS.get_env_logs,
      inputShape: LOGS_SHAPE,
      async handler(raw) {
        const input = z.object(LOGS_SHAPE).parse(raw);
        const snapshot = self.docker.getLogBufferSnapshot(
          envId,
          input.maxChars ?? 8000
        );
        if (!snapshot) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No logs buffered for env ${envId}. Either nothing has run yet or the buffer was cleared by a fresh start. Call start_env or rebuild_env if you want to see the lifecycle output.`,
              },
            ],
          };
        }
        return {
          content: [{ type: "text" as const, text: snapshot }],
        };
      },
    };

    return {
      name: "withvibe-docker",
      version: "1.0.0",
      tools: [
        startEnv,
        stopEnv,
        rebuildEnv,
        getEnvStatus,
        waitForEnvStatus,
        getEnvLogs,
      ],
    };
  }

  createMcpServer(envId: string): McpSdkServerConfigWithInstance {
    const spec = this.describeMcpServer(envId);
    return createSdkMcpServer({
      name: spec.name,
      version: spec.version,
      tools: spec.tools.map((t) =>
        tool(t.name, t.description, t.inputShape, t.handler)
      ),
    });
  }
}
