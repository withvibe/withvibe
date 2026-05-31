"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  BarChart,
  Bell,
  Book,
  BookOpen,
  Bot,
  Box,
  Brain,
  Calendar,
  CheckSquare,
  Clock,
  Cloud,
  Code,
  Code2,
  Container,
  Database,
  Eye,
  FileCode,
  FileText,
  Fingerprint,
  Folder,
  Gauge,
  GitBranch,
  GitCommit,
  GitFork,
  GitPullRequest,
  Globe,
  HardDrive,
  Kanban,
  Key,
  LayoutGrid,
  LayoutList,
  Library,
  LineChart,
  Link as LinkIcon,
  List,
  ListTodo,
  Loader2,
  Lock,
  Mail,
  Megaphone,
  MessageCircle,
  MessageSquare,
  Network,
  Package,
  PieChart,
  Puzzle,
  Route,
  Scan,
  ScrollText,
  Send,
  Server,
  Settings as SettingsIcon,
  Settings2,
  Share2,
  Shield,
  Sliders,
  Smile,
  Sparkles,
  Table as TableIcon,
  Terminal as TerminalIcon,
  TrendingUp,
  Wand,
  WandSparkles,
  Workflow,
  Wrench,
  Zap,
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

// Allowlist of lucide icon names plugins can reference from their manifest.
// Keep in sync with withvibe-site/src/lib/plugin-catalog.ts PLUGIN_ICON_GROUPS.
// Unknown names fall back to the puzzle piece. We list each icon explicitly
// (vs. pulling all of lucide) so the bundler tree-shakes properly.
const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  // Productivity
  "list-todo": ListTodo,
  kanban: Kanban,
  calendar: Calendar,
  clock: Clock,
  "check-square": CheckSquare,
  list: List,
  "layout-list": LayoutList,
  "layout-grid": LayoutGrid,
  // Dev
  code: Code,
  "code-2": Code2,
  terminal: TerminalIcon,
  "git-branch": GitBranch,
  "git-commit": GitCommit,
  "git-pull-request": GitPullRequest,
  package: Package,
  box: Box,
  container: Container,
  // Data
  database: Database,
  table: TableIcon,
  server: Server,
  "hard-drive": HardDrive,
  cloud: Cloud,
  folder: Folder,
  // Communication
  "message-circle": MessageCircle,
  "message-square": MessageSquare,
  mail: Mail,
  send: Send,
  bell: Bell,
  megaphone: Megaphone,
  // Docs
  book: Book,
  "book-open": BookOpen,
  "file-text": FileText,
  "file-code": FileCode,
  "scroll-text": ScrollText,
  library: Library,
  // Security
  shield: Shield,
  lock: Lock,
  key: Key,
  fingerprint: Fingerprint,
  scan: Scan,
  eye: Eye,
  // Monitoring
  activity: Activity,
  "bar-chart": BarChart,
  "line-chart": LineChart,
  "pie-chart": PieChart,
  gauge: Gauge,
  "trending-up": TrendingUp,
  // AI / Agents
  bot: Bot,
  sparkles: Sparkles,
  brain: Brain,
  wand: Wand,
  "wand-sparkles": WandSparkles,
  // Workflow
  workflow: Workflow,
  network: Network,
  "share-2": Share2,
  link: LinkIcon,
  route: Route,
  "git-fork": GitFork,
  // Other
  puzzle: Puzzle,
  settings: SettingsIcon,
  "settings-2": Settings2,
  sliders: Sliders,
  wrench: Wrench,
  zap: Zap,
  globe: Globe,
  smile: Smile,
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
