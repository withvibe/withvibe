import { type ZodRawShape } from "zod";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Context decoded from the short-lived bearer JWT that Claude Code runner
 * containers present when calling an HTTP MCP endpoint. All six bridged
 * servers derive their per-request scope from these fields.
 */
export type McpBridgeCtx = {
  workspaceId: string;
  envId: string;
  userId: string;
  sessionId: string | null;
  agentId: string | null;
};

export type McpToolDescriptor<Shape extends ZodRawShape = ZodRawShape> = {
  name: string;
  description: string;
  inputShape: Shape;
  handler: (input: Record<string, unknown>) => Promise<CallToolResult>;
};

export type McpServerSpec = {
  name: string;
  version: string;
  tools: McpToolDescriptor[];
};
