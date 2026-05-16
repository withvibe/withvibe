"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Terminal as TerminalIcon } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import "@xterm/xterm/css/xterm.css";

type Container = {
  id: string;
  name: string;
  status: string;
  image: string;
};

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

  if (!running) {
    return (
      <div className="h-full min-h-[400px] flex items-center justify-center text-center p-8 text-sm text-muted-foreground bg-muted/10">
        Start the container to open a terminal.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/30 text-xs font-mono text-muted-foreground">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-3.5" />
          <Select
            value={selected ?? ""}
            onValueChange={(v) => setSelected(v)}
            disabled={!containers || containers.length === 0}
          >
            <SelectTrigger size="sm" className="h-6 text-xs min-w-[180px]">
              <SelectValue
                placeholder={
                  containers === null
                    ? "Loading…"
                    : containers.length === 0
                      ? "No containers"
                      : "Pick a container"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {(containers || []).map((c) => (
                <SelectItem key={c.id} value={c.name}>
                  <div className="flex flex-col items-start">
                    <span className="font-mono">{c.name}</span>
                    <span className="text-[10px] opacity-70">{c.image}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          {connState === "open"
            ? "connected"
            : connState === "connecting"
              ? "connecting…"
              : connState === "closed"
                ? "disconnected"
                : connState === "error"
                  ? "error"
                  : ""}
        </span>
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
