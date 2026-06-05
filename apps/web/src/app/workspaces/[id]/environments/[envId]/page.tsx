"use client";

import { useRouter } from "next/navigation";
import { use, useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  FolderOpen,
  Globe,
  Database,
  Eye,
  GitBranch,
  Laptop,
  Play,
  RefreshCw,
  ScrollText,
  Settings2,
  Shield,
  Square,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { EnvironmentChat } from "./_chat";
import { EnvPanel, LogsPanel, PreviewPanel } from "./_runtime";
import { ComposeDialog } from "./_compose-dialog";
import { TerminalPanel } from "./_terminal";
import { AgentsPanel } from "./_agents-panel";
import { GitPanel } from "./_git-panel";
import { SecurityPanel } from "./_security-panel";
import { DatabasePanel, type DetectedDatabase } from "./_database";
import { QaBrowserPanel } from "./_qa-browser";
import { ContextPanel } from "./_context-panel";
import { ExportDialog } from "./_export-dialog";
import { VsCodeMenu } from "./_vscode-menu";
import {
  PluginIcon,
  PluginPanel,
  type PluginListRow,
  type PluginPrefRow,
} from "./_plugin-panel";
import { PluginManageDialog } from "./_plugin-manage-dialog";
import { useActiveRuns } from "../../_active-runs";
import { toast } from "sonner";

type ContainerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "partial"
  | "stopping"
  | "building"
  | "error";

type Environment = {
  id: string;
  title: string;
  description: string | null;
  containerStatus: ContainerStatus;
  serviceReady: boolean;
  containerPorts: Record<string, number> | null;
  serviceUrls: Record<string, string> | null;
  containerError: string | null;
  lastContainerAt: string | null;
  composeFile: string | null;
  assetFiles: { path: string; size: number; updatedAt: string }[];
  detectedDatabases: DetectedDatabase[] | null;
  dbViewerPort: number | null;
  dbViewerStatus: string | null;
  dbViewerError: string | null;
  chatEngine: "agent_sdk" | "claude_code";
  qaBrowserMode: "sidecar" | "user_browser";
  modelChoice:
    | "auto"
    | "claude-opus-4-7"
    | "claude-sonnet-4-6"
    | "claude-haiku-4-5"
    | null;
  sandboxBypass: boolean | null;
  runnerStatus: "running" | "stopped" | "image_missing" | null;
  createdAt: string;
  createdBy: { id: string; name: string | null; email: string } | null;
  repos: {
    envRepoId: string;
    id: string;
    name: string;
    url: string;
    cloneStatus: string;
    cloneBranch: string | null;
    baseBranch: string | null;
    envBranch: string | null;
    envCloneStatus: "pending" | "creating" | "ready" | "error";
    envCloneError: string | null;
  }[];
  canDelete: boolean;
};

const CONTAINER_BADGE: Record<
  ContainerStatus,
  { label: string; className: string; dot: string }
> = {
  stopped: {
    label: "stopped",
    className: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground/40",
  },
  starting: {
    label: "starting",
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    dot: "bg-yellow-400 animate-pulse",
  },
  running: {
    label: "running",
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    dot: "bg-emerald-400",
  },
  partial: {
    label: "partial",
    className: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    dot: "bg-orange-400",
  },
  stopping: {
    label: "stopping",
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    dot: "bg-yellow-400 animate-pulse",
  },
  building: {
    label: "building",
    className: "bg-primary/10 text-primary border-primary/20",
    dot: "bg-primary animate-pulse",
  },
  error: {
    label: "error",
    className: "bg-destructive/10 text-destructive border-destructive/20",
    dot: "bg-destructive",
  },
};

export default function EnvironmentDetailPage(
  props: PageProps<"/workspaces/[id]/environments/[envId]">
) {
  const { id, envId } = use(props.params);
  const router = useRouter();
  const [env, setEnv] = useState<Environment | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [acting, setActing] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<
    "preview" | "logs" | "env" | "terminal" | "agents" | "git" | "database" | "qa-browser" | "context" | "security" | null
  >(null);
  // Plugins (data-driven activity-bar entries). Cleared whenever the user
  // selects a built-in panel — only one panel is visible at a time.
  const [pluginList, setPluginList] = useState<PluginListRow[]>([]);
  const [pluginPrefs, setPluginPrefs] = useState<PluginPrefRow[]>([]);
  const [activePluginId, setActivePluginId] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [chatPrefill, setChatPrefill] = useState<
    { text: string; id: number } | null
  >(null);
  const [securityScanRequest, setSecurityScanRequest] = useState<
    number | null
  >(null);
  const [panelWidth, setPanelWidth] = useState(480);
  const [resizing, setResizing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteRemoteBranch, setDeleteRemoteBranch] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Live workspace-level SSE from ActiveRunsProvider tells us whether any
  // agent turn is in flight for this env. When the devops agent runs
  // `docker compose up` via its docker-mcp tool, containerStatus flips on
  // the server but the env detail GET isn't auto-refetched. Polling while
  // an agent is running covers that window — the SSE flag goes false when
  // the run ends, so polling stops itself.
  const { isRunning: isAgentRunningInEnv } = useActiveRuns();
  const agentRunning = isAgentRunningInEnv(envId);

  function togglePanel(
    p:
      | "preview"
      | "logs"
      | "env"
      | "terminal"
      | "agents"
      | "git"
      | "database"
      | "qa-browser"
      | "context"
      | "security"
  ) {
    setActivePluginId(null);
    setActivePanel((prev) => (prev === p ? null : p));
  }

  function togglePlugin(pluginId: string) {
    setActivePanel(null);
    setActivePluginId((prev) => (prev === pluginId ? null : pluginId));
  }

  // Open the Security panel and request a fresh scan. Bumping the signal
  // (even if the panel is already open) re-triggers the scan.
  const openSecurityScan = useCallback(() => {
    setActivePanel("security");
    setSecurityScanRequest(Date.now());
  }, []);

  function startPanelResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panelWidth;
    setResizing(true);
    function onMove(ev: MouseEvent) {
      // drag leftward = widen panel (it sits on the right side)
      const delta = startX - ev.clientX;
      setPanelWidth(Math.max(320, Math.min(1100, startWidth + delta)));
    }
    function onUp() {
      setResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }


  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${id}/envs/${envId}`);
    if (res.status === 404 || res.status === 403) {
      setNotFound(true);
      return;
    }
    if (res.ok) setEnv(await res.json());
  }, [id, envId]);

  const loadPlugins = useCallback(async () => {
    const [listRes, prefsRes] = await Promise.all([
      fetch(`/api/workspaces/${id}/envs/${envId}/plugins`),
      fetch(`/api/workspaces/${id}/envs/${envId}/plugins/prefs`),
    ]);
    if (listRes.ok) {
      const body = (await listRes.json()) as { plugins: PluginListRow[] };
      setPluginList(body.plugins);
    }
    if (prefsRes.ok) {
      const body = (await prefsRes.json()) as { prefs: PluginPrefRow[] };
      setPluginPrefs(body.prefs);
    }
  }, [id, envId]);

  useEffect(() => {
    load();
    loadPlugins();
  }, [load, loadPlugins]);

  useEffect(() => {
    if (!env) return;
    const containerTransitioning = [
      "starting",
      "stopping",
      "building",
    ].includes(env.containerStatus);
    // Keep polling while the container is up but the service inside is still
    // booting (healthcheck "starting"), so serviceReady flips without a manual
    // refresh and the "Service starting…" indicator clears on its own.
    const serviceBooting =
      env.containerStatus === "running" && !env.serviceReady;
    const reposCreating = env.repos.some(
      (r) => r.envCloneStatus === "pending" || r.envCloneStatus === "creating"
    );
    // Agent activity is a third trigger: while a turn is running, the agent
    // can mutate container state (docker-mcp's start_env/stop_env/rebuild)
    // and we won't otherwise know until the user navigates away and back.
    if (
      !containerTransitioning &&
      !reposCreating &&
      !agentRunning &&
      !serviceBooting
    )
      return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [env, load, agentRunning]);

  // Boot-time refresh window: poll for ~20s after the page first mounts so a
  // freshly-created env converges to its real state (status fields, clone
  // progress, ports) without needing the user to navigate away and back.
  // This sits alongside the transition-driven polling above; together they
  // cover the "everything looks idle but the server is still settling" gap
  // that was causing the Start button to look disabled after env creation.
  useEffect(() => {
    let ticks = 0;
    const t = setInterval(() => {
      ticks++;
      load();
      if (ticks >= 10) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
    // Intentionally only on mount — restarting on every `load` change would
    // re-arm the window after each fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function containerAction(action: "start" | "stop" | "rebuild") {
    setActing(true);
    try {
      const res = await fetch(
        `/api/workspaces/${id}/envs/${envId}/container`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }
      );
      if (!res.ok) {
        toast.error(`Failed to ${action}`);
        return;
      }
      toast.info(
        action === "start"
          ? "Starting…"
          : action === "stop"
            ? "Stopping…"
            : "Rebuilding…"
      );
      await load();
    } finally {
      setActing(false);
    }
  }

  function openDeleteDialog() {
    setDeleteConfirm("");
    setDeleteRemoteBranch(false);
    setDeleteOpen(true);
  }

  async function confirmDeleteEnv() {
    setDeleting(true);
    try {
      const qs = deleteRemoteBranch ? "?deleteRemoteBranch=1" : "";
      const res = await fetch(`/api/workspaces/${id}/envs/${envId}${qs}`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success("Environment deleted");
        router.push(`/workspaces/${id}`);
      } else {
        toast.error("Failed to delete environment");
      }
    } finally {
      setDeleting(false);
    }
  }

  if (notFound) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        Environment not found.
      </div>
    );
  }

  if (!env) {
    return (
      <div className="max-w-[1600px] mx-auto p-6 space-y-4">
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-[calc(100vh-200px)] rounded-md" />
      </div>
    );
  }

  const badge = CONTAINER_BADGE[env.containerStatus];
  const isRunning = env.containerStatus === "running";
  const isStopped =
    env.containerStatus === "stopped" || env.containerStatus === "error";
  const isTransitioning =
    env.containerStatus === "starting" ||
    env.containerStatus === "stopping" ||
    env.containerStatus === "building";

  return (
    <div className="max-w-[1600px] mx-auto p-4 sm:p-6 flex flex-col gap-4 h-[calc(100vh-3.5rem)] min-h-[640px] min-w-0 overflow-hidden">
      {/* Full-viewport overlay during panel resize — sits above iframes/xterm
          so mouse events keep flowing to our window listeners. */}
      {resizing && (
        <div
          className="fixed inset-0 z-[100] cursor-col-resize select-none"
          style={{ userSelect: "none" }}
        />
      )}
      {/* Compact toolbar */}
      <header className="space-y-2 shrink-0">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 space-y-1 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-mono",
                  badge.className
                )}
              >
                <span className={cn("size-1.5 rounded-full", badge.dot)} />
                {badge.label}
              </span>
              {isRunning && !env.serviceReady && (
                <span
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[11px] font-mono"
                  title="The container is up, but the service inside is still booting (installing deps / first compile). The preview will be ready shortly."
                >
                  <span className="size-1.5 rounded-full bg-amber-500 animate-pulse" />
                  Service starting…
                </span>
              )}
              <h1 className="text-xl font-mono font-bold tracking-tight break-words">
                {env.title}
              </h1>
            </div>
            {env.description && (
              <p className="text-sm text-foreground/85 whitespace-pre-wrap">
                {env.description}
              </p>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="outline"
              disabled={acting || isTransitioning}
              onClick={() => containerAction("start")}
              title={
                isRunning
                  ? "Bring the container up (idempotent)"
                  : "Start container"
              }
            >
              <Play className="size-4" />
              {isRunning ? "Restart" : "Start"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              // `building` is intentionally allowed: cold builds can run for
              // several minutes (mvn package, large image layers) and the
              // user should be able to abort. `docker compose down` kills
              // an in-flight build gracefully.
              disabled={
                acting ||
                isStopped ||
                env.containerStatus === "starting" ||
                env.containerStatus === "stopping"
              }
              onClick={() => containerAction("stop")}
              title={
                env.containerStatus === "building"
                  ? "Cancel build"
                  : "Stop container"
              }
            >
              <Square className="size-4" />
              {env.containerStatus === "building" ? "Cancel" : "Stop"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={acting || isTransitioning}
              onClick={() => containerAction("rebuild")}
              title="Rebuild container"
            >
              <RefreshCw className="size-4" />
              Rebuild
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setExportOpen(true)}
              title="Export this env and run it on your machine"
            >
              <Laptop className="size-4" />
              Export
            </Button>
            {env.canDelete && (
              <>
                <div className="w-px h-6 bg-border mx-1" />
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={openDeleteDialog}
                  title="Delete environment"
                >
                  <Trash2 className="size-4 text-destructive" />
                </Button>
              </>
            )}
          </div>
        </div>

        {env.containerError && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertDescription>
              <div className="font-medium mb-1">Container failed to start</div>
              <button
                type="button"
                onClick={() => setErrorExpanded((v) => !v)}
                className="text-xs text-primary hover:underline mb-1"
              >
                {errorExpanded ? "Hide details" : "Show details"}
              </button>
              {errorExpanded && (
                <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] font-mono max-h-60 overflow-auto bg-destructive/5 p-2 rounded">
                  {env.containerError}
                </pre>
              )}
            </AlertDescription>
          </Alert>
        )}
      </header>

      {/* Main: chat (flex-1) + optional side panel; activity bar absolutely
          pinned to the right edge so it can't be pushed off-screen */}
      <div className="relative flex gap-2 flex-1 min-h-0 min-w-0 overflow-hidden pr-14">
        <div className="flex-1 min-w-0 overflow-hidden">
          <EnvironmentChat
            workspaceId={id}
            envId={envId}
            envBuilt={isRunning}
            prefill={chatPrefill}
            onRunSecurityScan={openSecurityScan}
          />
        </div>

        {(activePanel || activePluginId) && (
          <aside
            style={{ width: panelWidth }}
            className="shrink-0 relative flex flex-col rounded-md border bg-card overflow-hidden"
          >
            {/* Left-edge drag handle — resizes the panel */}
            <div
              onMouseDown={startPanelResize}
              className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/40 active:bg-primary/60 transition-colors z-10"
              title="Drag to resize"
            />
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/60 bg-muted/30 shrink-0">
              <span className="text-xs font-mono font-medium capitalize">
                {activePluginId
                  ? pluginList.find((p) => p.id === activePluginId)?.name ??
                    activePluginId
                  : activePanel}
              </span>
              <button
                type="button"
                onClick={() => {
                  setActivePanel(null);
                  setActivePluginId(null);
                }}
                className="inline-flex items-center justify-center size-6 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                title="Close panel"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {activePanel === "preview" && (
                <PreviewPanel
                  containerStatus={env.containerStatus}
                  serviceReady={env.serviceReady}
                  containerPorts={env.containerPorts}
                  serviceUrls={env.serviceUrls}
                />
              )}
              {activePanel === "logs" && (
                <LogsPanel
                  workspaceId={id}
                  envId={envId}
                  running={isRunning || isTransitioning}
                />
              )}
              {activePanel === "env" && (
                <div className="h-full overflow-auto">
                  <EnvPanel
                    workspaceId={id}
                    envId={envId}
                    repos={env.repos}
                    composeFile={env.composeFile}
                    chatEngine={env.chatEngine}
                    qaBrowserMode={env.qaBrowserMode}
                    modelChoice={env.modelChoice}
                    sandboxBypass={env.sandboxBypass}
                    runnerStatus={env.runnerStatus}
                    serviceUrls={env.serviceUrls}
                    containerPorts={env.containerPorts}
                    onOpenCompose={() => setComposeOpen(true)}
                    onUpdated={load}
                    pluginPrefsCount={pluginPrefs.length}
                    pluginsEnabledCount={
                      pluginPrefs.filter((p) => p.enabled).length
                    }
                    onManagePlugins={() => setManageOpen(true)}
                  />
                </div>
              )}
              {activePanel === "terminal" && (
                <TerminalPanel
                  workspaceId={id}
                  envId={envId}
                  running={isRunning}
                />
              )}
              {activePanel === "agents" && (
                <AgentsPanel workspaceId={id} envId={envId} />
              )}
              {activePanel === "git" && (
                <GitPanel
                  workspaceId={id}
                  envId={envId}
                  onAskAgent={(text) =>
                    setChatPrefill({ text, id: Date.now() })
                  }
                  onRunSecurityScan={openSecurityScan}
                />
              )}
              {activePanel === "security" && (
                <SecurityPanel
                  workspaceId={id}
                  envId={envId}
                  scanRequest={securityScanRequest}
                  onScanHandled={() => setSecurityScanRequest(null)}
                />
              )}
              {activePanel === "database" && (
                <DatabasePanel
                  workspaceId={id}
                  envId={envId}
                  containerStatus={env.containerStatus}
                  detectedDatabases={env.detectedDatabases}
                  dbViewerPort={env.dbViewerPort}
                  dbViewerStatus={env.dbViewerStatus}
                  onAction={load}
                />
              )}
              {activePanel === "qa-browser" && (
                <QaBrowserPanel
                  workspaceId={id}
                  envId={envId}
                  containerRunning={env.containerStatus === "running"}
                  qaBrowserMode={env.qaBrowserMode}
                />
              )}
              {activePanel === "context" && (
                <ContextPanel workspaceId={id} envId={envId} />
              )}
              {activePluginId && (
                <PluginPanel
                  workspaceId={id}
                  envId={envId}
                  pluginId={activePluginId}
                  containerRunning={env.containerStatus === "running"}
                />
              )}
            </div>
          </aside>
        )}

        <nav className="absolute right-0 top-0 bottom-0 w-12 flex flex-col items-center gap-1 py-2 rounded-md border bg-card">
          <ActivityIcon
            label="Preview"
            active={activePanel === "preview"}
            onClick={() => togglePanel("preview")}
          >
            <Eye className="size-4" />
          </ActivityIcon>
          <ActivityIcon
            label="Logs"
            active={activePanel === "logs"}
            onClick={() => togglePanel("logs")}
          >
            <ScrollText className="size-4" />
          </ActivityIcon>
          <ActivityIcon
            label="Settings"
            active={activePanel === "env"}
            onClick={() => togglePanel("env")}
          >
            <Settings2 className="size-4" />
          </ActivityIcon>
          <ActivityIcon
            label="Git"
            active={activePanel === "git"}
            onClick={() => togglePanel("git")}
          >
            <GitBranch className="size-4" />
          </ActivityIcon>
          <ActivityIcon
            label="Security scan"
            active={activePanel === "security"}
            onClick={() => togglePanel("security")}
          >
            <Shield className="size-4" />
          </ActivityIcon>
          <ActivityIcon
            label="Database"
            active={activePanel === "database"}
            onClick={() => togglePanel("database")}
          >
            <Database className="size-4" />
          </ActivityIcon>
          <ActivityIcon
            label="QA Browser"
            active={activePanel === "qa-browser"}
            onClick={() => togglePanel("qa-browser")}
          >
            <Globe className="size-4" />
          </ActivityIcon>
          <ActivityIcon
            label="Extra Context"
            active={activePanel === "context"}
            onClick={() => togglePanel("context")}
          >
            <FolderOpen className="size-4" />
          </ActivityIcon>
          <ActivityIcon
            label="Terminal"
            active={activePanel === "terminal"}
            onClick={() => togglePanel("terminal")}
          >
            <TerminalIcon className="size-4" />
          </ActivityIcon>
          <VsCodeMenu
            workspaceId={id}
            envId={envId}
            containerStatus={env.containerStatus}
          />
          <ActivityIcon
            label="Agents"
            active={activePanel === "agents"}
            onClick={() => togglePanel("agents")}
          >
            <Bot className="size-4" />
          </ActivityIcon>
          {pluginList.length > 0 && (
            <div className="my-1 mx-auto h-px w-6 bg-border" />
          )}
          {pluginList.map((p) => (
            <ActivityIcon
              key={p.id}
              label={p.name}
              active={activePluginId === p.id}
              onClick={() => togglePlugin(p.id)}
            >
              <PluginIcon name={p.icon} className="size-4" />
            </ActivityIcon>
          ))}
        </nav>
      </div>

      <ComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        workspaceId={id}
        envId={envId}
        initialValue={env.composeFile}
        initialAssets={env.assetFiles ?? []}
        onSaved={load}
      />

      <PluginManageDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        workspaceId={id}
        envId={envId}
        initialPrefs={pluginPrefs}
        onChanged={loadPlugins}
      />

      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        envId={env.id}
        envTitle={env.title}
      />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              Delete environment?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes <strong>{env.title}</strong>
              {" "}and everything tied to it — chat history, agent sessions,
              container state, and every uncommitted change on the AI&apos;s
              env clones. If you haven&apos;t pushed your branches from
              the <strong>Git</strong> tab, that code is gone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 mt-4">
            <label
              htmlFor="env-delete-confirm"
              className="block text-xs font-mono text-muted-foreground"
            >
              Type <code className="px-1 py-0.5 rounded bg-muted text-foreground">delete</code> to confirm:
            </label>
            <Input
              id="env-delete-confirm"
              autoFocus
              autoComplete="off"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder="delete"
              disabled={deleting}
            />
            {/* Opt-in remote branch deletion. Default off because a deleted
                remote branch can't be un-deleted, and the env's branch is
                sometimes useful to keep around (open PRs, work the user
                wants to revisit). */}
            <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={deleteRemoteBranch}
                onChange={(e) => setDeleteRemoteBranch(e.target.checked)}
                disabled={deleting}
              />
              <span>
                Also delete the env branch on origin (
                <code className="px-1 py-0.5 rounded bg-muted text-foreground">
                  git push origin --delete
                </code>
                ). Can&apos;t be undone.
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteEnv}
              disabled={
                deleting || deleteConfirm.trim().toLowerCase() !== "delete"
              }
            >
              {deleting ? "Deleting…" : "Delete environment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActivityIcon({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center size-8 rounded-md transition-smooth relative",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:text-primary hover:bg-muted"
      )}
    >
      {children}
      {active && (
        <span className="absolute -left-2 top-1/2 -translate-y-1/2 h-4 w-0.5 bg-primary rounded-r" />
      )}
    </button>
  );
}
