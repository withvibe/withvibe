import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { WebSocket } from "ws";
import type {
  BrowserOps,
  WaitState,
  WaitUntil,
} from "./qa-browser-ops";

type Pairing = {
  envId: string;
  userId: string;
  socket: WebSocket;
  pageUrl: string | null;
  pageTitle: string | null;
  lastSeenAt: Date;
  pendingByRequestId: Map<
    string,
    { resolve: (v: unknown) => void; reject: (err: Error) => void; op: string }
  >;
};

type ExtensionMessage =
  | { type: "hello"; pageUrl?: string; pageTitle?: string }
  | { type: "page_state"; pageUrl: string; pageTitle: string }
  | { type: "rpc_response"; requestId: string; ok: true; result?: unknown }
  | { type: "rpc_response"; requestId: string; ok: false; error: string };

const RPC_TIMEOUT_MS = 30_000;

/**
 * Tracks paired Chrome extensions and forwards browser-driving RPC calls to
 * them. There's at most one active pairing per (envId, userId): a user can
 * only attach one Chrome window at a time to a given env.
 *
 * The pairing is established by the WebSocket gateway after JWT auth — this
 * service just stores the socket and provides the dispatch surface used by
 * the QA agent's MCP tools.
 */
@Injectable()
export class UserBrowserBridgeService {
  private readonly logger = new Logger(UserBrowserBridgeService.name);
  // Keyed by `${envId}::${userId}`. The QA agent dispatches per env; if
  // multiple users in the same workspace pair their browsers to the same env,
  // each owns their own pairing — the agent uses the speaker's pairing.
  private readonly pairings = new Map<string, Pairing>();

  registerPairing(args: {
    envId: string;
    userId: string;
    socket: WebSocket;
  }): { ok: true } {
    const key = pairKey(args.envId, args.userId);
    const existing = this.pairings.get(key);
    if (existing && existing.socket !== args.socket) {
      // Replacing a stale socket — close the old one cleanly. The new socket
      // takes over ownership of any in-flight requests, but in practice the
      // old socket's pending RPCs will fail with the close.
      try {
        existing.socket.close(4000, "Replaced by newer connection");
      } catch {
        // best-effort
      }
      for (const pending of existing.pendingByRequestId.values()) {
        pending.reject(new Error("Extension reconnected"));
      }
    }
    this.pairings.set(key, {
      envId: args.envId,
      userId: args.userId,
      socket: args.socket,
      pageUrl: null,
      pageTitle: null,
      lastSeenAt: new Date(),
      pendingByRequestId: new Map(),
    });
    this.logger.log(
      `QA-browser extension paired: env=${args.envId} user=${args.userId}`
    );
    return { ok: true };
  }

  removePairing(args: { envId: string; userId: string; socket: WebSocket }) {
    const key = pairKey(args.envId, args.userId);
    const pairing = this.pairings.get(key);
    if (!pairing || pairing.socket !== args.socket) return;
    for (const pending of pairing.pendingByRequestId.values()) {
      pending.reject(new Error("Extension disconnected"));
    }
    this.pairings.delete(key);
    this.logger.log(
      `QA-browser extension unpaired: env=${args.envId} user=${args.userId}`
    );
  }

  handleMessage(args: {
    envId: string;
    userId: string;
    socket: WebSocket;
    raw: string;
  }) {
    const pairing = this.pairings.get(pairKey(args.envId, args.userId));
    if (!pairing || pairing.socket !== args.socket) return;
    let msg: ExtensionMessage;
    try {
      msg = JSON.parse(args.raw) as ExtensionMessage;
    } catch (err) {
      this.logger.warn(`Bad ext message json: ${(err as Error).message}`);
      return;
    }
    pairing.lastSeenAt = new Date();
    switch (msg.type) {
      case "hello":
      case "page_state": {
        const next = msg as { pageUrl?: string; pageTitle?: string };
        if (typeof next.pageUrl === "string") pairing.pageUrl = next.pageUrl;
        if (typeof next.pageTitle === "string")
          pairing.pageTitle = next.pageTitle;
        return;
      }
      case "rpc_response": {
        const pending = pairing.pendingByRequestId.get(msg.requestId);
        if (!pending) return;
        pairing.pendingByRequestId.delete(msg.requestId);
        if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(
            new Error(msg.error || `${pending.op} failed in extension`)
          );
        }
        return;
      }
      default: {
        this.logger.warn(
          `Unknown ext message type: ${(msg as { type?: string }).type}`
        );
      }
    }
  }

  status(args: {
    envId: string;
    userId: string;
  }): {
    connected: boolean;
    pageUrl: string | null;
    pageTitle: string | null;
    lastSeenAt: string | null;
  } {
    const pairing = this.pairings.get(pairKey(args.envId, args.userId));
    if (!pairing) {
      return {
        connected: false,
        pageUrl: null,
        pageTitle: null,
        lastSeenAt: null,
      };
    }
    return {
      connected: pairing.socket.readyState === 1,
      pageUrl: pairing.pageUrl,
      pageTitle: pairing.pageTitle,
      lastSeenAt: pairing.lastSeenAt.toISOString(),
    };
  }

  hasPairing(args: { envId: string; userId: string }): boolean {
    const pairing = this.pairings.get(pairKey(args.envId, args.userId));
    return Boolean(pairing && pairing.socket.readyState === 1);
  }

  /**
   * Build a `BrowserOps` that dispatches to the user's paired extension. The
   * returned object captures (envId, userId) — call it per chat session. If
   * the pairing isn't available at call time, each method throws with a clear
   * message so the agent can surface the failure to the user.
   */
  opsFor(args: { envId: string; userId: string }): BrowserOps {
    const dispatch = <T>(op: string, params: unknown): Promise<T> =>
      this.rpc<T>({ envId: args.envId, userId: args.userId, op, params });

    return {
      navigate: (a) => dispatch("navigate", { ...a, url: rewriteForHost(a.url) }),
      click: (a) => dispatch("click", a),
      fill: (a) => dispatch("fill", a),
      press: (a) => dispatch("press", a),
      waitFor: (a) => dispatch("wait_for", a),
      snapshot: () => dispatch("snapshot", {}),
      screenshot: (a) => dispatch("screenshot", a),
      evaluate: (a) => dispatch("evaluate", a),
      currentState: () => dispatch("current_state", {}),
      goBack: () => dispatch("go_back", {}),
      reload: () => dispatch("reload", {}),
      textContent: (a) => dispatch("text_content", a),
    };
  }

  private rpc<T>(args: {
    envId: string;
    userId: string;
    op: string;
    params: unknown;
  }): Promise<T> {
    const pairing = this.pairings.get(pairKey(args.envId, args.userId));
    if (!pairing || pairing.socket.readyState !== 1) {
      return Promise.reject(
        new Error(
          "QA browser extension is not connected. Install the WithVibe Chrome extension and pair it with this env from the QA Browser tab."
        )
      );
    }
    const requestId = randomUUID();
    const payload = JSON.stringify({
      type: "rpc_request",
      requestId,
      op: args.op,
      params: args.params,
    });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pairing.pendingByRequestId.delete(requestId);
        reject(
          new Error(
            `Browser ${args.op} timed out after ${RPC_TIMEOUT_MS / 1000}s`
          )
        );
      }, RPC_TIMEOUT_MS);
      pairing.pendingByRequestId.set(requestId, {
        op: args.op,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        pairing.socket.send(payload);
      } catch (err) {
        pairing.pendingByRequestId.delete(requestId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

function pairKey(envId: string, userId: string): string {
  return `${envId}::${userId}`;
}

/**
 * The agent's system prompt tells it to navigate to `host.docker.internal:<port>`
 * (which works for the sidecar — that's a container with the docker host bridge).
 * In user_browser mode the QA browser is the user's real Chrome on the host
 * machine, where `host.docker.internal` doesn't resolve. Rewrite to `localhost`
 * so misbehaving agent calls still work. Same applies to compose service names —
 * we can only rewrite to localhost since we don't have the port mapping here;
 * the agent should be picking host ports already, but this catches the obvious
 * docker-internal hostname case.
 */
function rewriteForHost(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "host.docker.internal") {
      u.hostname = "localhost";
      return u.toString();
    }
    return url;
  } catch {
    return url;
  }
}

// Re-exports so the gateway file doesn't need to import qa-browser-ops directly.
export type { BrowserOps, WaitUntil, WaitState };
