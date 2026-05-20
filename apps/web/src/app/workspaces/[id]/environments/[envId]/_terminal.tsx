"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Play,
  RefreshCw,
  Square,
  Terminal as TerminalIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import "@xterm/xterm/css/xterm.css";

type Container = {
  id: string;
  name: string;
  // compose service name (e.g. "backend"), authoritative for lifecycle verbs.
  service: string;
  status: string;
  image: string;
};

type ServiceAction = "start" | "stop" | "rebuild";

type ConnState = "idle" | "connecting" | "open" | "closed" | "error";

export function TerminalPanel({
  workspaceId,
  envId,
  running,
}: {
  workspaceId: string;
  envId: string;
  running: boolean;
}) {
  const [containers, setContainers] = useState<Container[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [connState, setConnState] = useState<ConnState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  // Disable a row's buttons while an action is in flight on that service so
  // double-clicks don't queue duplicates. Keyed by compose service name.
  const [actingOn, setActingOn] = useState<Record<string, ServiceAction | null>>(
    {}
  );
  const termRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<{
    term: import("@xterm/xterm").Terminal;
    fit: import("@xterm/addon-fit").FitAddon;
  } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const loadContainers = useCallback(async () => {
    setLoadError(null);
    const res = await fetch(
      `/api/workspaces/${workspaceId}/envs/${envId}/container/containers`
    );
    if (!res.ok) {
      setLoadError(`Failed to list containers (${res.status})`);
      return;
    }
    const data = (await res.json()) as { containers: Container[] };
    setContainers(data.containers);
    if (data.containers.length > 0) {
      setSelected((prev) => prev || data.containers[0].name);
    } else {
      setSelected(null);
    }
  }, [workspaceId, envId]);

  useEffect(() => {
    if (running) loadContainers();
    else {
      setContainers([]);
      setSelected(null);
    }
  }, [running, loadContainers]);

  // Mount xterm once the pane is visible. Cleanup on unmount.
  useEffect(() => {
    if (!termRef.current) return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const xterm = await import("@xterm/xterm");
      const fit = await import("@xterm/addon-fit");
      if (cancelled || !termRef.current) return;

      const term = new xterm.Terminal({
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        cursorBlink: true,
        theme: {
          background: "#0a0a0c",
          foreground: "#e5e7eb",
          cursor: "#e5e7eb",
          selectionBackground: "#334155",
        },
      });
      const fitAddon = new fit.FitAddon();
      term.loadAddon(fitAddon);
      term.open(termRef.current);
      fitAddon.fit();

      termInstanceRef.current = { term, fit: fitAddon };

      const handleResize = () => {
        try {
          fitAddon.fit();
        } catch {}
      };
      window.addEventListener("resize", handleResize);

      cleanup = () => {
        window.removeEventListener("resize", handleResize);
        try {
          term.dispose();
        } catch {}
        termInstanceRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
    };
  }, []);

  // Open WS whenever a container is selected.
  useEffect(() => {
    if (!selected || !termInstanceRef.current) {
      closeWs();
      return;
    }
    const { term, fit } = termInstanceRef.current;
    term.clear();
    term.writeln(
      `\x1b[90m> connecting to ${selected}…\x1b[0m`
    );
    setConnState("connecting");

    // Mint a bridge JWT from Next, then connect directly to the NestJS WS
    // on its own host. Browsers can't set custom headers on WS handshakes,
    // so we pass the token via `?token=<jwt>`.
    let cancelled = false;
    let ws: WebSocket | null = null;
    let onData: { dispose: () => void } | null = null;
    let onResize: { dispose: () => void } | null = null;

    void (async () => {
      try {
        const tokenRes = await fetch("/api/terminal/ws-token", {
          method: "POST",
        });
        if (!tokenRes.ok) throw new Error(`ws-token HTTP ${tokenRes.status}`);
        const { token, apiBaseUrl } = (await tokenRes.json()) as {
          token: string;
          apiBaseUrl: string;
        };
        if (cancelled) return;

        const apiUrl = new URL(apiBaseUrl);
        const wsProto = apiUrl.protocol === "https:" ? "wss:" : "ws:";
        const url = `${wsProto}//${apiUrl.host}/api/terminal/${envId}/${encodeURIComponent(
          selected
        )}?token=${encodeURIComponent(token)}`;
        ws = new WebSocket(url);
        wsRef.current = ws;
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          setConnState("open");
          try {
            fit.fit();
          } catch {}
          try {
            ws!.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              })
            );
          } catch {}
        };
        ws.onmessage = (ev) => {
          if (typeof ev.data === "string") term.write(ev.data);
          else if (ev.data instanceof ArrayBuffer)
            term.write(new Uint8Array(ev.data));
        };
        ws.onclose = () => {
          setConnState("closed");
          term.writeln("\r\n\x1b[90m> connection closed\x1b[0m");
        };
        ws.onerror = () => {
          setConnState("error");
        };

        onData = term.onData((data) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode(data));
          }
        });
        onResize = term.onResize(({ cols, rows }) => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        });
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          `Failed to start terminal session: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        setConnState("error");
      }
    })();

    return () => {
      cancelled = true;
      onData?.dispose();
      onResize?.dispose();
      try {
        ws?.close();
      } catch {}
    };
  }, [selected, envId]);

  function closeWs() {
    try {
      wsRef.current?.close();
    } catch {}
    wsRef.current = null;
  }

  // Per-service lifecycle. Hits the same env action endpoint as the
  // workspace-level start/stop/rebuild buttons — adding `service` selects
  // a single compose service. The api streams progress into the env's
  // log buffer, which the Logs panel renders via SSE.
  const serviceAction = useCallback(
    async (service: string, action: ServiceAction) => {
      setActingOn((p) => ({ ...p, [service]: action }));
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/envs/${envId}/container`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, service }),
          }
        );
        if (!res.ok) {
          toast.error(`Failed to ${action} ${service}`);
          return;
        }
        toast.info(`${capitalize(action)}ing ${service}…`);
        // Refresh after a short delay so the status badge reflects the
        // new state. The action is async server-side; this is just a
        // best-effort UI refresh, not authoritative.
        setTimeout(() => {
          void loadContainers();
        }, 1500);
      } finally {
        setActingOn((p) => ({ ...p, [service]: null }));
      }
    },
    [workspaceId, envId, loadContainers]
  );

  if (!running) {
    return (
      <div className="h-full min-h-[400px] flex items-center justify-center text-center p-8 text-sm text-muted-foreground bg-muted/10">
        Start the container to open a terminal.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/30 text-[11px] font-mono text-muted-foreground">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-3.5" />
          <span>Services</span>
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            title="Refresh container list"
            onClick={loadContainers}
          >
            <RefreshCw className="size-3" />
          </Button>
        </div>
        <span>
          {selected ? (
            <>
              terminal:{" "}
              <span className="text-foreground">{selected}</span>{" "}
              {connState === "open"
                ? "(connected)"
                : connState === "connecting"
                  ? "(connecting…)"
                  : connState === "closed"
                    ? "(disconnected)"
                    : connState === "error"
                      ? "(error)"
                      : ""}
            </>
          ) : null}
        </span>
      </div>
      <div className="max-h-[40%] overflow-auto border-b border-border/60 bg-card/30">
        {containers === null ? (
          <div className="px-3 py-2 text-xs font-mono text-muted-foreground italic">
            Loading services…
          </div>
        ) : containers.length === 0 ? (
          <div className="px-3 py-2 text-xs font-mono text-muted-foreground italic">
            No running containers.
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {containers.map((c) => {
              const isSelected = selected === c.name;
              const busy = actingOn[c.service];
              const state = classifyStatus(c.status);
              const isRunning = state === "running" || state === "unhealthy";
              // Disable rules mirror docker compose's own no-op behavior so
              // the UI never invites a click that won't do anything useful:
              //   Start/Restart  — enabled unless we're already acting or the
              //                    container is mid-transition (Restarting /
              //                    Removing); compose up is idempotent so it
              //                    stays enabled in every other state.
              //   Stop           — only when the container is actually up.
              //   Rebuild        — same gate as Start; refuses to fight an
              //                    in-flight transition.
              const transitioning =
                state === "restarting" || state === "removing";
              return (
                <li
                  key={c.id}
                  className={`flex items-center justify-between gap-3 px-3 py-2 text-xs font-mono cursor-pointer transition-colors ${
                    isSelected
                      ? "bg-primary/10 border-l-2 border-l-primary"
                      : "hover:bg-muted/30 border-l-2 border-l-transparent"
                  }`}
                  onClick={() => setSelected(c.name)}
                >
                  <div className="flex flex-col min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-block size-2 rounded-full shrink-0 ${stateDotClass(state)}`}
                        aria-hidden
                      />
                      <span className="font-semibold truncate">{c.service}</span>
                    </div>
                    <span
                      className={`text-[10px] truncate pl-4 ${stateTextClass(state)}`}
                    >
                      {c.status} · {c.image}
                    </span>
                  </div>
                  <div
                    className="flex items-center gap-1 shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ServiceActionButton
                      icon={<Play className="size-3" />}
                      label={isRunning ? "Restart" : "Start"}
                      active={busy === "start"}
                      disabled={!!busy || transitioning}
                      onClick={() => serviceAction(c.service, "start")}
                    />
                    <ServiceActionButton
                      icon={<Square className="size-3" />}
                      label="Stop"
                      active={busy === "stop"}
                      disabled={!!busy || !isRunning}
                      onClick={() => serviceAction(c.service, "stop")}
                    />
                    <ServiceActionButton
                      icon={<RefreshCw className="size-3" />}
                      label="Rebuild"
                      active={busy === "rebuild"}
                      disabled={!!busy || transitioning}
                      onClick={() => serviceAction(c.service, "rebuild")}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {loadError && (
        <div className="px-3 py-2 text-xs font-mono text-destructive bg-destructive/10 border-b border-destructive/30">
          {loadError}
        </div>
      )}
      <div
        ref={termRef}
        className="flex-1 min-h-0 bg-black/80 p-2"
        onClick={() => termInstanceRef.current?.term.focus()}
      />
    </div>
  );
}

function ServiceActionButton({
  icon,
  label,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-7"
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {active ? <RefreshCw className="size-3 animate-spin" /> : icon}
    </Button>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Coarse classification of `docker ps`'s status column. Format varies:
//   "Up 5 minutes"               → running
//   "Up About an hour (healthy)" → running
//   "Up 2 minutes (unhealthy)"   → unhealthy
//   "Restarting (1) 3s ago"      → restarting
//   "Exited (0) 12 minutes ago"  → stopped
//   "Created"                    → created
//   "Paused"                     → paused
//   "Removing"                   → removing
//   "Dead"                       → dead
type ServiceState =
  | "running"
  | "unhealthy"
  | "restarting"
  | "stopped"
  | "created"
  | "paused"
  | "removing"
  | "dead"
  | "unknown";

function classifyStatus(status: string): ServiceState {
  if (status.startsWith("Up")) {
    return status.includes("(unhealthy)") ? "unhealthy" : "running";
  }
  if (status.startsWith("Restarting")) return "restarting";
  if (status.startsWith("Exited")) return "stopped";
  if (status.startsWith("Created")) return "created";
  if (status.startsWith("Paused")) return "paused";
  if (status.startsWith("Removing")) return "removing";
  if (status.startsWith("Dead")) return "dead";
  return "unknown";
}

function stateDotClass(state: ServiceState): string {
  switch (state) {
    case "running":
      return "bg-emerald-500";
    case "unhealthy":
      return "bg-amber-500";
    case "restarting":
    case "removing":
      return "bg-sky-500 animate-pulse";
    case "stopped":
    case "created":
    case "paused":
      return "bg-muted-foreground/40";
    case "dead":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

function stateTextClass(state: ServiceState): string {
  switch (state) {
    case "unhealthy":
      return "text-amber-400/80";
    case "dead":
      return "text-destructive/80";
    case "restarting":
    case "removing":
      return "text-sky-400/80";
    default:
      return "opacity-70";
  }
}
