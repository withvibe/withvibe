"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Calendar,
  Code,
  Database,
  FileText,
  Globe,
  Kanban,
  ListTodo,
  Loader2,
  Puzzle,
  ScrollText,
  Settings2,
  Shield,
  Smile,
  Terminal as TerminalIcon,
} from "lucide-react";

export type PluginListRow = {
  id: string;
  name: string;
  icon: string | null;
  scope: "env" | "workspace" | "global";
  status: string;
  error: string | null;
  viewerUrl: string | null;
  enabled: boolean;
};

export type PluginPrefRow = {
  id: string;
  name: string;
  icon: string | null;
  scope: "env" | "workspace" | "global";
  enabled: boolean;
};

type StartBody =
  | { ok: true; status: string; viewerUrl: string | null }
  | { ok: false; error: string };

// Small static map of lucide icons we accept as manifest values. Unknown
// names fall back to the puzzle-piece icon — keeps the bundle small and
// avoids the bundler pulling in every lucide icon.
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  puzzle: Puzzle,
  database: Database,
  globe: Globe,
  code: Code,
  "list-todo": ListTodo,
  kanban: Kanban,
  calendar: Calendar,
  "file-text": FileText,
  shield: Shield,
  "scroll-text": ScrollText,
  smile: Smile,
  bot: Bot,
  terminal: TerminalIcon,
  settings: Settings2,
};

export function PluginIcon({
  name,
  className,
}: {
  name: string | null;
  className?: string;
}) {
  const Cmp = (name && ICONS[name]) || Puzzle;
  return <Cmp className={className} />;
}

export function PluginPanel({
  workspaceId,
  envId,
  pluginId,
  containerRunning,
}: {
  workspaceId: string;
  envId: string;
  pluginId: string;
  containerRunning: boolean;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "starting" }
    | { kind: "running"; viewerUrl: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    if (!containerRunning) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "starting" });
    (async () => {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/plugins/${pluginId}/start`,
        { method: "POST" }
      );
      if (cancelled) return;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        setState({
          kind: "error",
          message: text || `Failed to start (HTTP ${res.status})`,
        });
        return;
      }
      const body = (await res.json()) as StartBody;
      if (cancelled) return;
      if (body.ok && body.viewerUrl) {
        setState({ kind: "running", viewerUrl: body.viewerUrl });
      } else {
        setState({
          kind: "error",
          message: body.ok
            ? "Plugin did not produce a viewer URL"
            : body.error,
        });
      }
    })().catch((err) => {
      if (!cancelled) {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, envId, pluginId, containerRunning]);

  if (!containerRunning) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-sm text-muted-foreground text-center">
        Start the env to use this plugin.
      </div>
    );
  }

  if (state.kind === "starting" || state.kind === "idle") {
    return (
      <div className="h-full flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Starting plugin…
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 p-6 text-sm">
        <AlertTriangle className="size-5 text-destructive" />
        <div className="font-medium text-destructive">
          Plugin failed to start
        </div>
        <pre className="text-xs whitespace-pre-wrap max-h-40 overflow-auto bg-destructive/5 p-2 rounded">
          {state.message}
        </pre>
      </div>
    );
  }

  return (
    <iframe
      src={state.viewerUrl}
      title="Plugin"
      // Phase-1: permissive sandbox so plugins behave like our existing
      // sidecars (allow-same-origin lets cookies flow). Phase-4 hardening
      // tightens this for untrusted authors via the manifest permissions.
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      className="w-full h-full border-0"
    />
  );
}
