"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  FileCode,
  GitBranch,
  Loader2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { MODEL_OPTIONS, type ModelChoice } from "@/lib/models";

export type ChatEngine = "agent_sdk" | "claude_code";
export type QaBrowserMode = "sidecar" | "user_browser";

export type ContainerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "partial"
  | "stopping"
  | "building"
  | "error";

export type RepoInfo = {
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
};

const LOG_CAP = 200_000; // characters

/**
 * Build a github.com `/tree/<branch>` URL from the canonical repo URL.
 * Branch names can contain `/` (e.g., `env/foo-abc123`) — the path
 * segments are kept literal so github routes correctly.
 */
function branchUrlFor(repoUrl: string, branch: string): string {
  const clean = repoUrl.replace(/\.git$/, "").replace(/\/+$/, "");
  const safeBranch = branch
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${clean}/tree/${safeBranch}`;
}

export function PreviewPanel({
  containerStatus,
  containerPorts,
  serviceUrls,
}: {
  containerStatus: ContainerStatus;
  containerPorts: Record<string, number> | null;
  serviceUrls: Record<string, string> | null;
}) {
  // Subdomain-mode: serviceUrls populated at materialize time. Prefer a
  // service called "web" or "frontend", otherwise the first entry.
  const { primaryUrl, primaryLabel, otherUrls } = useMemo(() => {
    if (serviceUrls && Object.keys(serviceUrls).length > 0) {
      const entries = Object.entries(serviceUrls);
      // Frontend-ish service names, most-specific first. "admin" is common for
      // internal admin UIs; "ui"/"app" cover generic SPAs.
      const preferred = ["web", "frontend", "admin", "ui", "app"];
      const preferredKey =
        preferred
          .map((name) => entries.find(([k]) => k === name)?.[0])
          .find((k): k is string => !!k) ?? entries[0][0];
      const primary = serviceUrls[preferredKey];
      const others = entries
        .filter(([k]) => k !== preferredKey)
        .map(([k, v]) => ({ key: k, url: v }));
      return {
        primaryUrl: primary,
        primaryLabel: new URL(primary).host,
        otherUrls: others,
      };
    }
    // Port-mode: existing behavior
    const webPort = containerPorts?.web;
    if (!webPort) {
      return { primaryUrl: null, primaryLabel: null, otherUrls: [] };
    }
    const others = containerPorts
      ? Object.entries(containerPorts)
          .filter(([k]) => k !== "web")
          .map(([, v]) => v)
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .map((p) => ({ key: `:${p}`, url: `http://localhost:${p}` }))
      : [];
    return {
      primaryUrl: `http://localhost:${webPort}`,
      primaryLabel: `localhost:${webPort}`,
      otherUrls: others,
    };
  }, [containerPorts, serviceUrls]);

  const running = containerStatus === "running";
  const busy =
    containerStatus === "starting" ||
    containerStatus === "building" ||
    containerStatus === "stopping";

  if (!running && !busy) {
    return <Placeholder>Start the container to see the app preview.</Placeholder>;
  }
  if (busy && !primaryUrl) {
    return <Placeholder>Container is starting…</Placeholder>;
  }
  if (!primaryUrl) {
    return (
      <Placeholder>
        Container is running but doesn&apos;t expose a web port. Add a port
        mapping in your docker-compose.yml (or enable subdomain routing in
        workspace settings).
      </Placeholder>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/30 text-xs font-mono text-muted-foreground shrink-0">
        <span>
          <span className="text-foreground">{primaryLabel}</span>
          {otherUrls.length > 0 && (
            <span className="ml-3 opacity-70">
              also:{" "}
              {otherUrls.map((o, i) => (
                <span key={o.url}>
                  {i > 0 && ", "}
                  <a
                    href={o.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-foreground underline-offset-2 hover:underline"
                  >
                    {o.key}
                  </a>
                </span>
              ))}
            </span>
          )}
        </span>
        <a
          href={primaryUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          Open in new tab
          <ExternalLink className="size-3" />
        </a>
      </div>
      <iframe
        src={primaryUrl}
        className="w-full flex-1 bg-white"
        title="Environment preview"
      />
    </div>
  );
}

export function EnvPanel({
  workspaceId,
  envId,
  repos,
  composeFile,
  chatEngine,
  qaBrowserMode,
  modelChoice,
  sandboxBypass,
  runnerStatus,
  serviceUrls,
  containerPorts,
  onOpenCompose,
  onUpdated,
}: {
  workspaceId: string;
  envId: string;
  repos: RepoInfo[];
  composeFile: string | null;
  chatEngine: ChatEngine;
  qaBrowserMode: QaBrowserMode;
  /** null = inherit workspace default. */
  modelChoice: ModelChoice | null;
  /** null = inherit workspace/deployment default. */
  sandboxBypass: boolean | null;
  runnerStatus: "running" | "stopped" | "image_missing" | null;
  serviceUrls: Record<string, string> | null;
  containerPorts: Record<string, number> | null;
  onOpenCompose: () => void;
  onUpdated: () => void | Promise<void>;
}) {
  const [savingEngine, setSavingEngine] = useState<ChatEngine | null>(null);
  const [savingQaMode, setSavingQaMode] = useState<QaBrowserMode | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [savingSandbox, setSavingSandbox] = useState(false);

  // null sentinel = "use workspace default"; everything else is a concrete
  // ModelChoice that overrides the workspace setting for this env.
  async function setModel(next: ModelChoice | null) {
    if (next === modelChoice || savingModel) return;
    setSavingModel(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modelChoice: next }),
        }
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "Failed to save");
        toast.error(msg || "Failed to save");
        return;
      }
      toast.success(
        next === null
          ? "Model: using workspace default"
          : `Model set to ${MODEL_OPTIONS.find((o) => o.id === next)?.label ?? next}`
      );
      await onUpdated();
    } finally {
      setSavingModel(false);
    }
  }

  // null = inherit workspace/deployment default; true/false force Claude
  // Bypass Permissions on/off for this env's desktop/tunnel VS Code.
  async function setSandbox(next: boolean | null) {
    if (next === sandboxBypass || savingSandbox) return;
    setSavingSandbox(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sandboxBypass: next }),
        }
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "Failed to save");
        toast.error(msg || "Failed to save");
        return;
      }
      toast.success(
        next === null
          ? "Bypass Permissions: using workspace default"
          : next
            ? "Bypass Permissions enabled for this env"
            : "Bypass Permissions disabled for this env"
      );
      await onUpdated();
    } finally {
      setSavingSandbox(false);
    }
  }

  async function setQaMode(next: QaBrowserMode) {
    if (next === qaBrowserMode || savingQaMode) return;
    setSavingQaMode(next);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qaBrowserMode: next }),
        }
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "Failed to save");
        toast.error(msg || "Failed to save");
        return;
      }
      toast.success(
        next === "user_browser"
          ? "QA browser → your real Chrome (extension)"
          : "QA browser → Docker sidecar"
      );
      await onUpdated();
    } finally {
      setSavingQaMode(null);
    }
  }

  async function setEngine(next: ChatEngine) {
    if (next === chatEngine || savingEngine) return;
    setSavingEngine(next);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatEngine: next }),
        }
      );
      if (!res.ok) {
        const msg = await res.text().catch(() => "Failed to save");
        toast.error(msg || "Failed to save");
        return;
      }
      toast.success(
        next === "claude_code"
          ? "Chat engine set to Claude Code (runner container)"
          : "Chat engine set to Agent SDK (in-process)"
      );
      await onUpdated();
    } finally {
      setSavingEngine(null);
    }
  }

  const serviceEntries: { name: string; url: string }[] = (() => {
    if (serviceUrls && Object.keys(serviceUrls).length > 0) {
      return Object.entries(serviceUrls).map(([name, url]) => ({ name, url }));
    }
    if (containerPorts && Object.keys(containerPorts).length > 0) {
      // Port-mode: surface the same info as URLs to localhost:<port>.
      return Object.entries(containerPorts)
        .filter(([, v]) => typeof v === "number" && v > 0)
        .map(([name, port]) => ({
          name: name === "web" ? "web" : name,
          url: `http://localhost:${port}`,
        }));
    }
    return [];
  })();

  return (
    <div className="p-4 space-y-5">
      {serviceEntries.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
            Services
          </h3>
          <p className="text-[11px] text-muted-foreground">
            Where each service is reachable. Click to open in a new tab.
          </p>
          <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-card/30 text-xs font-mono">
            {serviceEntries.map(({ name, url }) => (
              <li
                key={name}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span className="text-foreground truncate">{name}</span>
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-muted-foreground hover:text-primary inline-flex items-center gap-1 truncate max-w-[60%]"
                  title={url}
                >
                  <span className="truncate">{new URL(url).host}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
          Chat engine
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Which engine drives chat in this env. <strong>Agent SDK</strong> runs
          in the API process (current default). <strong>Claude Code</strong>{" "}
          runs the real <code className="font-mono">claude</code> CLI inside a
          runner container attached to this env.
        </p>
        <div className="inline-flex rounded-md border bg-card p-0.5" role="group">
          {(
            [
              { value: "agent_sdk", label: "Agent SDK" },
              { value: "claude_code", label: "Claude Code" },
            ] as { value: ChatEngine; label: string }[]
          ).map((opt) => {
            const active = chatEngine === opt.value;
            const busy = savingEngine === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={savingEngine !== null}
                onClick={() => setEngine(opt.value)}
                className={cn(
                  "px-3 py-1 text-xs font-mono rounded transition-smooth inline-flex items-center gap-1.5",
                  active
                    ? "bg-primary/15 text-primary border border-primary/30"
                    : "text-muted-foreground hover:text-foreground",
                  savingEngine !== null && !busy && "opacity-50"
                )}
              >
                {busy && <Loader2 className="size-3 animate-spin" />}
                {opt.label}
              </button>
            );
          })}
        </div>
        {chatEngine === "claude_code" && runnerStatus && (
          <div className="text-[11px] font-mono">
            <span className="text-muted-foreground">Runner: </span>
            {runnerStatus === "running" ? (
              <span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                running
              </span>
            ) : runnerStatus === "stopped" ? (
              <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground border">
                stopped — will start on next chat turn
              </span>
            ) : (
              <span className="px-1.5 py-0.5 rounded bg-destructive/10 text-destructive border border-destructive/20">
                image missing — build <code>withvibe-claude-runner:latest</code>
              </span>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
          AI model
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Which Claude model handles chat in this env.{" "}
          <strong>Use workspace default</strong> inherits the value from
          workspace settings. <strong>Auto</strong> runs a cheap classifier each
          turn to pick Opus / Sonnet / Haiku based on task complexity.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { id: null, label: "Use workspace default" },
              ...MODEL_OPTIONS.map((o) => ({ id: o.id as ModelChoice | null, label: o.label })),
            ]
          ).map((opt) => {
            const active = opt.id === modelChoice;
            return (
              <button
                key={opt.id ?? "inherit"}
                type="button"
                disabled={savingModel}
                onClick={() => setModel(opt.id)}
                className={cn(
                  "px-2.5 py-1 text-[11px] font-mono rounded border transition-smooth inline-flex items-center gap-1.5",
                  active
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "bg-card text-muted-foreground border-border/60 hover:text-foreground",
                  savingModel && !active && "opacity-50"
                )}
              >
                {savingModel && active && (
                  <Loader2 className="size-3 animate-spin" />
                )}
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
          Claude Bypass Permissions
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Whether Claude Code may auto-approve actions (Bypass Permissions
          mode) in this env&apos;s desktop/tunnel VS Code.{" "}
          <strong>Use workspace default</strong> inherits the workspace
          setting (which itself falls back to the API server&apos;s
          IS_SANDBOX default). <strong>Off</strong> means Claude runs with
          normal permission prompts here; Bypass Permissions mode is
          unavailable.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { key: "inherit", val: null, label: "Use workspace default" },
              { key: "on", val: true, label: "On" },
              { key: "off", val: false, label: "Off" },
            ] as { key: string; val: boolean | null; label: string }[]
          ).map((opt) => {
            const active = opt.val === sandboxBypass;
            return (
              <button
                key={opt.key}
                type="button"
                disabled={savingSandbox}
                onClick={() => setSandbox(opt.val)}
                className={cn(
                  "px-2.5 py-1 text-[11px] font-mono rounded border transition-smooth inline-flex items-center gap-1.5",
                  active
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "bg-card text-muted-foreground border-border/60 hover:text-foreground",
                  savingSandbox && !active && "opacity-50"
                )}
              >
                {savingSandbox && active && (
                  <Loader2 className="size-3 animate-spin" />
                )}
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
          QA browser
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Where the QA agent runs the browser. <strong>Sidecar</strong> is a
          headless Docker Chromium streamed to you over VNC — isolated, runs
          unattended. <strong>My browser</strong> uses the WithVibe Chrome
          extension to drive a tab in your real Chrome (faster, real login, but
          shows Chrome&apos;s &quot;extension is debugging&quot; banner and
          requires you to be present).
        </p>
        <div className="inline-flex rounded-md border bg-card p-0.5" role="group">
          {(
            [
              { value: "sidecar", label: "Sidecar" },
              { value: "user_browser", label: "My browser" },
            ] as { value: QaBrowserMode; label: string }[]
          ).map((opt) => {
            const active = qaBrowserMode === opt.value;
            const busy = savingQaMode === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={savingQaMode !== null}
                onClick={() => setQaMode(opt.value)}
                className={cn(
                  "px-3 py-1 text-xs font-mono rounded transition-smooth inline-flex items-center gap-1.5",
                  active
                    ? "bg-primary/15 text-primary border border-primary/30"
                    : "text-muted-foreground hover:text-foreground",
                  savingQaMode !== null && !busy && "opacity-50"
                )}
              >
                {busy && <Loader2 className="size-3 animate-spin" />}
                {opt.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
          Repositories
        </h3>
        <p className="text-[11px] text-muted-foreground">
          The AI works on its own branch per repo, in a fresh local clone.
          Edits land on this branch — your base branch stays untouched until
          you commit and push from the <strong>Git</strong> tab.
        </p>
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No repositories attached.
          </p>
        ) : (
          <ul className="space-y-2">
            {repos.map((r) => {
              const base = r.baseBranch || r.cloneBranch || "main";
              const branchHref = r.envBranch
                ? branchUrlFor(r.url, r.envBranch)
                : r.url;
              return (
                <li
                  key={r.envRepoId}
                  className="flex items-start gap-3 rounded-md border bg-card px-3 py-2"
                >
                  <GitBranch className="size-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {/* Repo name → opens the AI branch on GitHub if known,
                        else the repo root. Branch URL 404s until pushed. */}
                    <div className="flex items-center gap-1.5">
                      <a
                        href={branchHref}
                        target="_blank"
                        rel="noreferrer"
                        title={
                          r.envBranch
                            ? `Open branch on GitHub (push it first from the Git tab)`
                            : "Open repo on GitHub"
                        }
                        className="text-sm font-mono font-medium hover:text-primary inline-flex items-center gap-1"
                      >
                        {r.name}
                        <ExternalLink className="size-3 text-muted-foreground" />
                      </a>
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer"
                        title="Open repo root on GitHub"
                        className="text-[10px] font-mono text-muted-foreground hover:text-foreground"
                      >
                        repo
                      </a>
                    </div>

                    {/* AI branch — visible as soon as the branch name is
                        chosen, even before the clone is finished. */}
                    {r.envBranch ? (
                      <div className="flex items-center gap-1.5 flex-wrap text-[11px] font-mono">
                        <span className="text-muted-foreground">AI branch:</span>
                        <a
                          href={branchHref}
                          target="_blank"
                          rel="noreferrer"
                          title="Open branch on GitHub (push it first from the Git tab)"
                          className="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 inline-flex items-center gap-1 break-all"
                        >
                          {r.envBranch}
                          <ExternalLink className="size-2.5 opacity-70" />
                        </a>
                        <button
                          type="button"
                          title="Copy branch name"
                          onClick={() =>
                            navigator.clipboard.writeText(r.envBranch ?? "")
                          }
                          className="text-muted-foreground hover:text-foreground"
                        >
                          copy
                        </button>
                        <span className="text-muted-foreground">
                          ← base{" "}
                          <code className="text-foreground/80">{base}</code>
                        </span>
                        {r.envCloneStatus !== "ready" && (
                          <span
                            title={
                              r.envCloneStatus === "error"
                                ? "Clone or push to GitHub failed — see details below"
                                : "Cloning the repo, creating the branch, and pushing it to GitHub. Usually 10–60s."
                            }
                            className={cn(
                              "inline-flex items-center gap-1 px-1 rounded text-[10px]",
                              r.envCloneStatus === "error"
                                ? "bg-destructive/10 text-destructive border border-destructive/20"
                                : "bg-muted text-muted-foreground border"
                            )}
                          >
                            {(r.envCloneStatus === "creating" ||
                              r.envCloneStatus === "pending") && (
                              <Loader2 className="size-2.5 animate-spin" />
                            )}
                            {r.envCloneStatus === "error"
                              ? "clone failed"
                              : r.envCloneStatus}
                          </span>
                        )}
                      </div>
                    ) : r.envCloneStatus === "error" ? (
                      <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-destructive/10 text-destructive border border-destructive/20">
                        clone failed
                      </span>
                    ) : (
                      <span
                        title="Cloning the repo, creating the branch, and pushing it to GitHub. Usually 10–60s."
                        className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground border inline-flex items-center gap-1"
                      >
                        <Loader2 className="size-2.5 animate-spin" />
                        {r.envCloneStatus}
                      </span>
                    )}
                    {r.envCloneStatus === "error" && r.envCloneError && (
                      <pre className="text-[11px] font-mono text-destructive whitespace-pre-wrap break-all">
                        {r.envCloneError}
                      </pre>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
          Compose
        </h3>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onOpenCompose}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border bg-card hover:border-primary/40 text-xs font-mono transition-smooth"
          >
            <FileCode className="size-3.5" />
            Compose:{" "}
            <span className="text-foreground">
              {composeFile ? "custom" : "auto-detected"}
            </span>
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          The env picks up a compose file in this order: custom override → env
          root → first attached repo. Need help setting one up? Ask the
          pinned <strong>DevOps</strong>&nbsp;agent in chat — that&apos;s what it&apos;s for.
        </p>
      </section>
    </div>
  );
}

export function LogsPanel({
  workspaceId,
  envId,
  running,
}: {
  workspaceId: string;
  envId: string;
  running: boolean;
}) {
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after the stream ends to re-trigger the effect (auto-reconnect
  // while the container is still running).
  const [reconnectKey, setReconnectKey] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    // Open the log stream whenever the container is not fully stopped —
    // includes building/starting so the user sees build output live.
    if (!running) {
      setStreaming(false);
      return;
    }

    const controller = new AbortController();
    const url = `/api/workspaces/${workspaceId}/envs/${envId}/container/logs`;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    setStreaming(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok || !res.body) {
          setError(`Log stream failed (${res.status})`);
          setStreaming(false);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const raw of events) {
            // NestJS @Sse emits `id: N\ndata: {...}\n\n`. Pull every `data:`
            // line from the event (spec-compliant: multi-line data is joined).
            const dataLines = raw
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (dataLines.length === 0) continue;
            const json = dataLines.join("\n").trim();
            if (!json) continue;
            try {
              const ev = JSON.parse(json) as {
                type: string;
                text?: string;
                error?: string;
              };
              if (ev.type === "log" && ev.text) {
                setText((prev) => {
                  const next = prev + ev.text;
                  return next.length > LOG_CAP
                    ? next.slice(next.length - LOG_CAP)
                    : next;
                });
              } else if (ev.type === "error") {
                setError(ev.error || "log error");
              } else if (ev.type === "closed" && ev.text) {
                setText((prev) => prev + `\n${ev.text}\n`);
              }
            } catch {}
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        // If aborted, a cleanup (unmount or effect re-run) is tearing this
        // stream down — don't touch state, or we'd clobber the next effect's
        // `setStreaming(true)` and leave the UI stuck on "Reconnecting…".
        if (!controller.signal.aborted) {
          setStreaming(false);
          reconnectTimer = setTimeout(
            () => setReconnectKey((k) => k + 1),
            2000
          );
        }
      }
    })();

    return () => {
      controller.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [workspaceId, envId, running, reconnectKey]);

  // auto-scroll to bottom when user is at the bottom
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    followRef.current = atBottom;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/30 text-xs font-mono text-muted-foreground">
        <span>
          {streaming
            ? "Streaming logs…"
            : running
              ? "Reconnecting…"
              : "Container not running"}
        </span>
        <button
          type="button"
          onClick={() => setText("")}
          className={cn(
            "inline-flex items-center gap-1 hover:text-foreground",
            !text && "opacity-30 pointer-events-none"
          )}
        >
          <Trash2 className="size-3" />
          Clear
        </button>
      </div>
      {error && (
        <div className="px-3 py-2 text-xs font-mono text-destructive bg-destructive/10 border-b border-destructive/30">
          {error}
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto bg-black/60 p-3 font-mono text-xs text-foreground/90 whitespace-pre-wrap break-all"
      >
        {text || (
          <span className="text-muted-foreground italic">
            {running ? "(waiting for output…)" : "(no logs yet)"}
          </span>
        )}
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full min-h-[400px] flex items-center justify-center text-center p-8 text-sm text-muted-foreground bg-muted/10">
      {children}
    </div>
  );
}
