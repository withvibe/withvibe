import { pageDriver, type DriverOp } from "./page-driver";
import type {
  ClientMessage,
  PopupRequest,
  PopupStatus,
  RpcOp,
  ServerMessage,
} from "./types";

const STORAGE_KEYS = {
  pairingUrl: "withvibe.pairingUrl",
} as const;

type ConnectionState =
  | { kind: "disconnected" }
  | { kind: "connecting"; pairingUrl: string }
  | {
      kind: "connected";
      pairingUrl: string;
      socket: WebSocket;
      envId: string | null;
    }
  | { kind: "error"; error: string; pairingUrl: string | null };

let state: ConnectionState = { kind: "disconnected" };
let lastTabSnapshot: { pageUrl?: string; pageTitle?: string } = {};
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_DELAY_MS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Boot — restore the last pairing URL and try to reconnect on extension load.
// MV3 service workers can sleep and respawn at any time, so we re-read storage
// every wake-up and resume the connection if we have a URL on file.
// ─────────────────────────────────────────────────────────────────────────────

void (async () => {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.pairingUrl]);
  const url = stored[STORAGE_KEYS.pairingUrl];
  if (typeof url === "string" && url.length > 0) {
    void connect(url);
  }
})();

chrome.tabs.onUpdated.addListener((id, info) => {
  if (
    id === sessionTabId &&
    (info.status === "complete" || typeof info.url === "string")
  ) {
    void refreshTabSnapshot();
  }
});

async function refreshTabSnapshot() {
  const tab = await getSessionTab();
  if (!tab) {
    lastTabSnapshot = {};
    return;
  }
  lastTabSnapshot = { pageUrl: tab.url, pageTitle: tab.title };
  if (state.kind === "connected") {
    sendClient({
      type: "page_state",
      pageUrl: tab.url ?? "",
      pageTitle: tab.title ?? "",
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup ↔ background messaging.
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: PopupRequest, _sender, respond) => {
  void handlePopupMessage(msg).then(respond);
  return true; // keep the sendResponse channel open for async work
});

async function handlePopupMessage(
  msg: PopupRequest
): Promise<PopupStatus | { ok: true }> {
  switch (msg.type) {
    case "popup:get_status":
      return currentStatus();
    case "popup:connect":
      await chrome.storage.local.set({
        [STORAGE_KEYS.pairingUrl]: msg.pairingUrl,
      });
      void connect(msg.pairingUrl);
      return { ok: true };
    case "popup:disconnect":
      cancelReconnect();
      disconnect();
      await chrome.storage.local.remove([STORAGE_KEYS.pairingUrl]);
      return { ok: true };
  }
}

function currentStatus(): PopupStatus {
  if (state.kind === "connected") {
    return {
      state: "connected",
      pairingUrl: state.pairingUrl,
      envId: state.envId ?? undefined,
      pageUrl: lastTabSnapshot.pageUrl,
      pageTitle: lastTabSnapshot.pageTitle,
    };
  }
  if (state.kind === "connecting") {
    return { state: "connecting", pairingUrl: state.pairingUrl };
  }
  if (state.kind === "error") {
    return {
      state: "error",
      error: state.error,
      pairingUrl: state.pairingUrl ?? undefined,
    };
  }
  return { state: "disconnected" };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket lifecycle.
// ─────────────────────────────────────────────────────────────────────────────

function connect(pairingUrl: string) {
  // Tear down any prior connection first.
  if (state.kind === "connected") {
    try {
      state.socket.close(1000, "Replaced by new connect");
    } catch {
      // best-effort
    }
  }
  cancelReconnect();
  state = { kind: "connecting", pairingUrl };

  let socket: WebSocket;
  try {
    socket = new WebSocket(pairingUrl);
  } catch (err) {
    state = {
      kind: "error",
      error: `Bad pairing URL: ${(err as Error).message}`,
      pairingUrl,
    };
    return;
  }

  socket.addEventListener("open", () => {
    state = {
      kind: "connected",
      pairingUrl,
      socket,
      envId: null,
    };
    void refreshTabSnapshot().then(() => {
      sendClient({
        type: "hello",
        pageUrl: lastTabSnapshot.pageUrl,
        pageTitle: lastTabSnapshot.pageTitle,
      });
    });
  });

  socket.addEventListener("message", (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "paired") {
      if (state.kind === "connected") {
        state = { ...state, envId: msg.envId };
      }
      return;
    }
    if (msg.type === "rpc_request") {
      void handleRpc(msg.requestId, msg.op, msg.params);
    }
  });

  socket.addEventListener("close", (ev) => {
    const wasIntentional =
      ev.code === 1000 || ev.code === 4000 || ev.code === 4001;
    state = wasIntentional
      ? { kind: "disconnected" }
      : {
          kind: "error",
          error: ev.reason || `WebSocket closed (code ${ev.code})`,
          pairingUrl,
        };
    if (!wasIntentional && pairingUrl) scheduleReconnect(pairingUrl);
  });

  socket.addEventListener("error", () => {
    // The "close" handler will run too — treat error as informational.
    if (state.kind === "connecting") {
      state = {
        kind: "error",
        error: "Failed to open WebSocket — is the API reachable?",
        pairingUrl,
      };
    }
  });
}

function disconnect() {
  if (state.kind === "connected") {
    try {
      state.socket.close(1000, "User disconnect");
    } catch {
      // best-effort
    }
  }
  state = { kind: "disconnected" };
  // Don't auto-close the session tab — the user may want to inspect it.
  // Just forget about it so the next pairing starts clean.
  sessionTabId = null;
}

function scheduleReconnect(pairingUrl: string) {
  cancelReconnect();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect(pairingUrl);
  }, RECONNECT_DELAY_MS);
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function sendClient(msg: ClientMessage) {
  if (state.kind !== "connected") return;
  try {
    state.socket.send(JSON.stringify(msg));
  } catch {
    // best-effort — connection issues will be caught by the close handler
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RPC dispatch — translate each server op into a Chrome-API call against the
// active tab.
// ─────────────────────────────────────────────────────────────────────────────

async function handleRpc(requestId: string, op: RpcOp, params: unknown) {
  try {
    const result = await dispatch(op, (params ?? {}) as Record<string, unknown>);
    sendClient({ type: "rpc_response", requestId, ok: true, result });
  } catch (err) {
    sendClient({
      type: "rpc_response",
      requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function dispatch(
  op: RpcOp,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (op) {
    case "navigate":
      return await opNavigate(params);
    case "screenshot":
      return await opScreenshot(params);
    case "go_back":
      return await opGoBack();
    case "reload":
      return await opReload();
    case "click":
    case "fill":
    case "press":
    case "wait_for":
    case "snapshot":
    case "current_state":
    case "text_content":
      return unwrap(await runDriver(op, params));
    case "evaluate":
      return unwrap(await runDriver(op, params, "MAIN"));
    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

async function runDriver(
  op: DriverOp,
  params: Record<string, unknown>,
  world: chrome.scripting.ExecutionWorld = "ISOLATED"
): Promise<unknown> {
  const tab = await requireSessionTab();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    world,
    func: pageDriver,
    args: [op, params],
  });
  if (!result) {
    throw new Error("Page driver returned no result (tab may have navigated mid-op)");
  }
  return result.result;
}

function unwrap(value: unknown): unknown {
  // Page-side ops always wrap success in a plain object and errors in
  // `{ __error__: string }`. Surface __error__ as a thrown Error so the MCP
  // tool handler returns a proper error to the agent.
  if (
    value &&
    typeof value === "object" &&
    "__error__" in (value as Record<string, unknown>)
  ) {
    throw new Error(String((value as { __error__: unknown }).__error__));
  }
  // For ops that report `{ value: ... }` (text_content), unwrap to the value.
  if (
    value &&
    typeof value === "object" &&
    Object.keys(value as Record<string, unknown>).length === 1 &&
    "value" in (value as Record<string, unknown>)
  ) {
    return (value as { value: unknown }).value;
  }
  return value;
}

// Session tab — the dedicated tab the agent drives. Set on first `navigate`
// (so we never hijack the WithVibe app tab the user is currently looking at)
// and cleared if the user closes it. All non-navigate ops require it to exist.
let sessionTabId: number | null = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sessionTabId) sessionTabId = null;
});

async function getSessionTab(): Promise<chrome.tabs.Tab | null> {
  if (sessionTabId == null) return null;
  try {
    return await chrome.tabs.get(sessionTabId);
  } catch {
    sessionTabId = null;
    return null;
  }
}

async function requireSessionTab(): Promise<chrome.tabs.Tab> {
  const tab = await getSessionTab();
  if (!tab || tab.id == null) {
    throw new Error(
      "No QA browser tab open — call `navigate` first to start a new tab the agent will drive."
    );
  }
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) {
    throw new Error(
      "Chrome blocks extensions from driving its internal pages. Call `navigate` to point this tab at an http(s) URL."
    );
  }
  return tab;
}

async function opNavigate(params: Record<string, unknown>) {
  const url = String(params.url ?? "");
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("URL must start with http:// or https://");
  }
  let tab = await getSessionTab();
  if (!tab || tab.id == null) {
    // First navigate of the session — open a dedicated tab so we don't
    // clobber whatever the user is currently looking at (the WithVibe app
    // itself, in particular).
    const created = await chrome.tabs.create({ url, active: true });
    if (created.id == null) {
      throw new Error("Failed to create QA browser tab");
    }
    sessionTabId = created.id;
    await waitForTabComplete(created.id);
    const refreshed = await chrome.tabs.get(created.id);
    return { url: refreshed.url ?? url, title: refreshed.title ?? "" };
  }
  await chrome.tabs.update(tab.id, { url, active: true });
  await waitForTabComplete(tab.id);
  const refreshed = await chrome.tabs.get(tab.id);
  return { url: refreshed.url ?? url, title: refreshed.title ?? "" };
}

function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Navigation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo
    ) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function opScreenshot(params: Record<string, unknown>) {
  if (params.fullPage) {
    // Full-page screenshots require chrome.debugger (Page.captureScreenshot
    // with captureBeyondViewport). Skipping for v1 — the agent can scroll +
    // re-screenshot if it needs more.
    throw new Error(
      "fullPage screenshots aren't supported in user-browser mode yet — request a viewport screenshot instead."
    );
  }
  const tab = await requireSessionTab();
  if (tab.windowId == null) throw new Error("Tab has no window");
  // Bring the session tab to the front before screenshotting — captureVisibleTab
  // only captures whatever is currently visible in the target window.
  await chrome.tabs.update(tab.id!, { active: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  // dataUrl looks like "data:image/png;base64,…" — strip the prefix.
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return { pngBase64: base64 };
}

async function opGoBack() {
  const tab = await requireSessionTab();
  await chrome.tabs.goBack(tab.id!);
  await waitForTabComplete(tab.id!);
  const refreshed = await chrome.tabs.get(tab.id!);
  return { url: refreshed.url ?? "" };
}

async function opReload() {
  const tab = await requireSessionTab();
  await chrome.tabs.reload(tab.id!);
  await waitForTabComplete(tab.id!);
  const refreshed = await chrome.tabs.get(tab.id!);
  return { url: refreshed.url ?? "" };
}
