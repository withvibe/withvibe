"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type Status = {
  status: "stopped" | "starting" | "running" | "error" | string;
  port: number | null;
  viewerUrl: string | null;
  error: string | null;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; status: Status }
  | { kind: "unreachable"; detail: string };

// Dev hosts often answer unknown /api/* with the Next.js index HTML — toasting
// that as-is is how you get a wall of <script> tags in the corner. Detect it
// and substitute a useful message instead.
function summarizeError(text: string, statusCode: number): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("<")) {
    return `API unreachable (HTTP ${statusCode} returned HTML — the API server probably hasn't picked up the new /qa-browser route. Restart it.)`;
  }
  try {
    const parsed = JSON.parse(trimmed) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through
  }
  return trimmed.slice(0, 300) || `Failed (HTTP ${statusCode})`;
}

export function QaBrowserPanel({
  workspaceId,
  envId,
  containerRunning,
  qaBrowserMode,
}: {
  workspaceId: string;
  envId: string;
  containerRunning: boolean;
  qaBrowserMode: "sidecar" | "user_browser";
}) {
  if (qaBrowserMode === "user_browser") {
    return (
      <UserBrowserPanel workspaceId={workspaceId} envId={envId} />
    );
  }
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [acting, setActing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (rootRef.current) {
        await rootRef.current.requestFullscreen();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/qa-browser`,
        { headers: { Accept: "application/json" } }
      );
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok || !ct.includes("application/json")) {
        const text = await res.text();
        setState({
          kind: "unreachable",
          detail: summarizeError(text, res.status),
        });
        return;
      }
      const json = (await res.json()) as Status;
      setState({ kind: "ok", status: json });
    } catch (err) {
      setState({
        kind: "unreachable",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }, [workspaceId, envId]);

  useEffect(() => {
    load();
    // Re-poll while transitional so the iframe appears as soon as the
    // sidecar is ready. The interval stays cheap (1.5s) but only re-fetches
    // when we know the sidecar is in flight.
    const t = setInterval(() => {
      setState((cur) => {
        if (cur.kind === "ok" && cur.status.status === "starting") {
          load();
        }
        return cur;
      });
    }, 1500);
    return () => clearInterval(t);
  }, [load]);

  async function start() {
    setActing(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/qa-browser`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ action: "start" }),
        }
      );
      if (!res.ok) {
        const text = await res.text();
        toast.error(summarizeError(text, res.status));
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  async function stop() {
    setActing(true);
    try {
      await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/qa-browser`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        }
      );
      await load();
    } finally {
      setActing(false);
    }
  }

  const headerLabel =
    state.kind === "loading"
      ? "loading…"
      : state.kind === "unreachable"
        ? "unreachable"
        : state.status.status;
  const isRunning =
    state.kind === "ok" && state.status.status === "running";

  return (
    <div ref={rootRef} className="flex flex-col h-full bg-background">
      <div className="flex items-center justify-between px-3 py-2 border-b text-xs">
        <div className="flex items-center gap-2">
          <Globe className="size-3.5" />
          <span className="font-medium">QA Browser</span>
          <span className="text-muted-foreground">({headerLabel})</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? (
              <Minimize2 className="size-3" />
            ) : (
              <Maximize2 className="size-3" />
            )}
          </Button>
          {isRunning ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={stop}
              disabled={acting}
            >
              <Square className="size-3 mr-1" /> Stop
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              onClick={start}
              disabled={acting || !containerRunning}
            >
              {acting ? (
                <Loader2 className="size-3 mr-1 animate-spin" />
              ) : (
                <Globe className="size-3 mr-1" />
              )}
              Start
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-muted/40">
        {state.kind === "loading" ? (
          <Placeholder>
            <Loader2 className="size-4 animate-spin inline mr-2" />
            Loading status…
          </Placeholder>
        ) : state.kind === "unreachable" ? (
          <Placeholder>
            <span className="text-destructive">Couldn&apos;t reach the API.</span>
            <div className="mt-2 text-xs">{state.detail}</div>
          </Placeholder>
        ) : !containerRunning ? (
          <Placeholder>
            Start the env first — the QA browser sidecar attaches to the
            env&apos;s docker network, which only exists while the env is
            running.
          </Placeholder>
        ) : state.status.status === "running" && state.status.viewerUrl ? (
          <iframe
            src={state.status.viewerUrl}
            className="w-full h-full border-0"
            title="QA Browser"
            allow="fullscreen"
            allowFullScreen
          />
        ) : state.status.status === "starting" ? (
          <Placeholder>
            <Loader2 className="size-4 animate-spin inline mr-2" />
            Booting headed Chromium… (first run pulls the image — can take a minute)
          </Placeholder>
        ) : state.status.status === "error" ? (
          <Placeholder>
            <span className="text-destructive">Error:</span>{" "}
            {state.status.error ?? "unknown failure"}
          </Placeholder>
        ) : (
          <Placeholder>
            Click <strong>Start</strong> to launch the QA browser, or just chat
            with the QA agent — the sidecar starts automatically on the first
            message.
          </Placeholder>
        )}
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center px-6 text-sm text-muted-foreground text-center">
      <div>{children}</div>
    </div>
  );
}

type ExtensionStatus = {
  connected: boolean;
  pageUrl: string | null;
  pageTitle: string | null;
  lastSeenAt: string | null;
};

function UserBrowserPanel({
  workspaceId,
  envId,
}: {
  workspaceId: string;
  envId: string;
}) {
  const [status, setStatus] = useState<ExtensionStatus | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/qa-browser/extension`,
        { headers: { Accept: "application/json" } }
      );
      if (!res.ok) {
        setUnreachable(`HTTP ${res.status}`);
        return;
      }
      const json = (await res.json()) as ExtensionStatus;
      setStatus(json);
      setUnreachable(null);
    } catch (err) {
      setUnreachable(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId, envId]);

  useEffect(() => {
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [load]);

  const mintPairingCode = useCallback(async () => {
    setMinting(true);
    setCopied(false);
    try {
      const res = await fetch("/api/qa-browser/ws-token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ envId }),
      });
      if (!res.ok) {
        toast.error(summarizeError(await res.text(), res.status));
        return;
      }
      const json = (await res.json()) as { pairingUrl: string };
      setPairingUrl(json.pairingUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setMinting(false);
    }
  }, [envId]);

  const copyPairing = useCallback(async () => {
    if (!pairingUrl) return;
    try {
      await navigator.clipboard.writeText(pairingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [pairingUrl]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b text-xs">
        <div className="flex items-center gap-2">
          <Globe className="size-3.5" />
          <span className="font-medium">QA Browser</span>
          <span
            className={
              status?.connected
                ? "text-emerald-500"
                : "text-muted-foreground"
            }
          >
            (
            {status?.connected
              ? "extension connected"
              : "waiting for extension"}
            )
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-muted/40 overflow-auto">
        {unreachable ? (
          <Placeholder>
            <span className="text-destructive">Couldn&apos;t reach the API.</span>
            <div className="mt-2 text-xs">{unreachable}</div>
          </Placeholder>
        ) : !status ? (
          <Placeholder>
            <Loader2 className="size-4 animate-spin inline mr-2" />
            Loading…
          </Placeholder>
        ) : status.connected ? (
          <div className="p-4 space-y-3 text-xs">
            <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-emerald-400">
              Extension connected. The QA agent will drive the active tab in
              your Chrome when it runs.
            </div>
            {status.pageUrl && (
              <div className="rounded-md border bg-card px-3 py-2 space-y-1 font-mono">
                <div className="text-muted-foreground text-[10px] uppercase tracking-wide">
                  Active tab
                </div>
                <div className="truncate" title={status.pageUrl}>
                  {status.pageUrl}
                </div>
                {status.pageTitle && (
                  <div className="text-muted-foreground truncate">
                    {status.pageTitle}
                  </div>
                )}
              </div>
            )}
            <p className="text-muted-foreground">
              Heads up: while the agent is driving, Chrome may show a yellow
              &quot;extension is debugging&quot; banner near the address bar
              for some operations (e.g. screenshots). That&apos;s a Chrome
              security feature — it can&apos;t be hidden.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={mintPairingCode}
              disabled={minting}
            >
              {minting ? (
                <Loader2 className="size-3 mr-1 animate-spin" />
              ) : null}
              Re-pair extension
            </Button>
            {pairingUrl && (
              <PairingDisplay
                pairingUrl={pairingUrl}
                copied={copied}
                onCopy={copyPairing}
              />
            )}
          </div>
        ) : (
          <div className="p-4 space-y-3 text-xs">
            <p>
              This env is set to drive <strong>your real Chrome</strong> via
              the WithVibe extension. Install the extension once, then pair it
              with this env using the code below.
            </p>
            <ol className="list-decimal pl-4 space-y-1.5 text-muted-foreground">
              <li>
                Build the extension:{" "}
                <code className="font-mono text-foreground">
                  pnpm --filter @withvibe/qa-browser-extension build
                </code>
              </li>
              <li>
                In Chrome, open{" "}
                <code className="font-mono text-foreground">
                  chrome://extensions
                </code>
                , enable Developer mode, click <em>Load unpacked</em>, and
                select{" "}
                <code className="font-mono text-foreground">
                  apps/qa-browser-extension/dist
                </code>
                .
              </li>
              <li>
                Click the WithVibe icon in your toolbar, paste the pairing
                code below, and hit Connect.
              </li>
            </ol>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={mintPairingCode}
              disabled={minting}
            >
              {minting ? (
                <Loader2 className="size-3 mr-1 animate-spin" />
              ) : null}
              Generate pairing code
            </Button>
            {pairingUrl && (
              <PairingDisplay
                pairingUrl={pairingUrl}
                copied={copied}
                onCopy={copyPairing}
              />
            )}
            <p className="text-muted-foreground">
              The code is a one-time URL valid for 5 minutes. Once paired,
              this panel will switch to &quot;extension connected.&quot;
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function PairingDisplay({
  pairingUrl,
  copied,
  onCopy,
}: {
  pairingUrl: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Pairing code (expires in 5 min)
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2"
          onClick={onCopy}
        >
          {copied ? (
            <>
              <Check className="size-3 mr-1" /> Copied
            </>
          ) : (
            <>
              <Copy className="size-3 mr-1" /> Copy
            </>
          )}
        </Button>
      </div>
      <code className="block break-all font-mono text-[11px] leading-snug">
        {pairingUrl}
      </code>
    </div>
  );
}
