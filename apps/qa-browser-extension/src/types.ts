/** Shared message types between popup ↔ background ↔ server. */

export type RpcOp =
  | "navigate"
  | "click"
  | "fill"
  | "press"
  | "wait_for"
  | "snapshot"
  | "screenshot"
  | "evaluate"
  | "current_state"
  | "go_back"
  | "reload"
  | "text_content";

export type ServerMessage =
  | { type: "paired"; envId: string; userId: string }
  | { type: "rpc_request"; requestId: string; op: RpcOp; params: unknown };

export type ClientMessage =
  | { type: "hello"; pageUrl?: string; pageTitle?: string }
  | { type: "page_state"; pageUrl: string; pageTitle: string }
  | { type: "rpc_response"; requestId: string; ok: true; result?: unknown }
  | { type: "rpc_response"; requestId: string; ok: false; error: string };

export type PopupRequest =
  | { type: "popup:get_status" }
  | { type: "popup:connect"; pairingUrl: string }
  | { type: "popup:disconnect" };

export type PopupStatus = {
  state: "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  pairingUrl?: string;
  envId?: string;
  pageUrl?: string;
  pageTitle?: string;
};
