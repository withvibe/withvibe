import type { PopupRequest, PopupStatus } from "./types";

const pairingEl = document.getElementById("pairing") as HTMLTextAreaElement;
const connectBtn = document.getElementById("connect") as HTMLButtonElement;
const disconnectBtn = document.getElementById(
  "disconnect"
) as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const statusLabel = document.getElementById("status-label") as HTMLSpanElement;
const statusMeta = document.getElementById("status-meta") as HTMLDivElement;

function send<T>(msg: PopupRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response: T) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

function render(status: PopupStatus) {
  statusEl.classList.remove("connected", "error");
  if (status.state === "connected") statusEl.classList.add("connected");
  if (status.state === "error") statusEl.classList.add("error");

  statusLabel.textContent = status.state;
  const lines: string[] = [];
  if (status.envId) lines.push(`env: ${status.envId}`);
  if (status.pageUrl) lines.push(`tab: ${truncate(status.pageUrl, 60)}`);
  if (status.error) lines.push(`error: ${status.error}`);
  statusMeta.textContent = lines.join("\n");
  statusMeta.style.whiteSpace = "pre-line";

  if (status.pairingUrl && !pairingEl.value) {
    pairingEl.value = status.pairingUrl;
  }
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function refresh() {
  try {
    const status = await send<PopupStatus>({ type: "popup:get_status" });
    render(status);
  } catch (err) {
    render({ state: "error", error: (err as Error).message });
  }
}

connectBtn.addEventListener("click", async () => {
  const pairingUrl = pairingEl.value.trim();
  if (!pairingUrl) {
    render({ state: "error", error: "Paste a pairing URL first." });
    return;
  }
  connectBtn.disabled = true;
  try {
    await send<{ ok: true }>({ type: "popup:connect", pairingUrl });
    await refresh();
  } catch (err) {
    render({ state: "error", error: (err as Error).message });
  } finally {
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener("click", async () => {
  disconnectBtn.disabled = true;
  try {
    await send<{ ok: true }>({ type: "popup:disconnect" });
    await refresh();
  } finally {
    disconnectBtn.disabled = false;
  }
});

void refresh();
const interval = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(interval));
