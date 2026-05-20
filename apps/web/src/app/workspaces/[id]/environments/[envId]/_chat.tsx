"use client";

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Render markdown anchors as new-tab links. Without this, react-markdown emits
// bare <a href> which navigates away from the env page when users click links
// posted in chat.
const MARKDOWN_COMPONENTS = {
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...props} target="_blank" rel="noopener noreferrer" />
  ),
} as const;
import {
  Bot,
  FileText,
  Loader2,
  MoreVertical,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Plus,
  ScanLine,
  Send,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";

type MessageSegment =
  | { type: "text"; text: string }
  /** `id` matches the model's tool_use_id. The UI uses it to look up `debug_tool_latency` and show a wall-clock duration on the tool card. */
  | { type: "tool_use"; name: string; input: unknown; id?: string };

type ToolLatency = {
  name: string;
  durationMs: number;
  isError?: boolean;
};

type StoredAttachment = {
  id: string;
  mime: string;
  size: number;
  originalName: string;
};

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  metadata: {
    toolCalls?: { name: string; input: unknown; id?: string }[];
    segments?: MessageSegment[];
    thinking?: string;
    suggestions?: string[];
    debugEvents?: DebugSdkEvent[];
    debugMeta?: DebugMeta;
    debugToolLatencies?: Record<string, ToolLatency>;
  } | null;
  createdAt: string;
  sessionId: string | null;
  attachments?: StoredAttachment[];
};

// Mirrors the server whitelist in apps/api/src/chat/attachments.constants.ts.
// Browsers report `text/x-…` for several source-code mimes; keep both lists
// loose-but-explicit so we can show a clear error before round-tripping.
const ATTACHMENT_ACCEPT =
  "image/png,image/jpeg,image/gif,image/webp," +
  "application/pdf," +
  "text/plain,text/markdown,text/csv,text/html,text/css,text/javascript,text/x-*," +
  "application/json,application/xml,application/x-yaml,application/yaml";
const MAX_ATTACHMENT_FILES = 10;
const MAX_ATTACHMENT_FILE_BYTES = 25 * 1024 * 1024;

type LiveAssistant = {
  content: string;
  thinking: string;
  toolCalls: { name: string; input: unknown; id?: string }[];
  segments: MessageSegment[];
  debug: DebugState;
};

type DebugSdkEvent = {
  sdkType: string;
  sdkSubtype?: string;
  sinceStartMs: number;
  sinceLastMs: number;
  summary?: string;
};

type DebugMeta = {
  model?: string;
  numTurns?: number;
  durationMs?: number;
  durationApiMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalCostUsd?: number;
  toolCallsByName: Record<string, number>;
  userPrompt?: string;
  systemAppend?: string;
  systemPresetNote?: string;
};

type RoutedModel = {
  model: string;
  auto: boolean;
  tier?: string;
};

type DebugState = {
  events: DebugSdkEvent[];
  meta: DebugMeta | null;
  /** Set when the backend emits debug_routed_model — i.e. as soon as the model router decides which model handles the current turn. */
  routedModel: RoutedModel | null;
  /** Per-tool wall-clock latencies, keyed by tool_use_id. Populated by debug_tool_latency events as `tool_result`s land. */
  toolLatencies: Record<string, ToolLatency>;
};

function emptyDebugState(): DebugState {
  return { events: [], meta: null, routedModel: null, toolLatencies: {} };
}

type AgentSummary = {
  id: string;
  slug: string;
  name: string;
};

type Session = {
  id: string;
  title: string | null;
  createdAt: string;
  messageCount: number;
  agent: AgentSummary | null;
};

type PinnedAgent = {
  id: string;
  slug: string;
  name: string;
  description: string;
  pinned: boolean;
  disabledInEnv?: boolean;
};

// "legacy" is the bucket for messages created before sessions existed (nullable sessionId).
type ActiveTab = string | "legacy";

type SessionState = {
  messages: StoredMessage[];
  messagesLoaded: boolean;
  live: LiveAssistant | null;
  controller: AbortController | null;
  error: string | null;
  // Number of follow-up messages the user typed while a turn was running.
  // The server queues them and auto-dispatches each as the next turn finishes.
  queuedCount: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors apps/api/src/chat/attachments.constants.ts — applied client-side
// so users see "type not allowed" before a slow upload round-trips.
function isAttachmentTypeAllowed(file: File): boolean {
  const t = file.type;
  if (!t) return false;
  if (t.startsWith("text/x-")) return true;
  return [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
    "text/markdown",
    "text/csv",
    "text/html",
    "text/css",
    "text/javascript",
    "application/json",
    "application/xml",
    "application/x-yaml",
    "application/yaml",
  ].includes(t);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function emptySessionState(): SessionState {
  return {
    messages: [],
    messagesLoaded: false,
    live: null,
    controller: null,
    error: null,
    queuedCount: 0,
  };
}

export function EnvironmentChat({
  workspaceId,
  envId,
  prefill,
  onRunSecurityScan,
}: {
  workspaceId: string;
  envId: string;
  prefill?: { text: string; id: number } | null;
  /** Opens the Security scan panel + kicks off a fresh scan. Shown as a
   *  quick action when the active session is the Security agent. */
  onRunSecurityScan?: () => void;
}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [legacyCount, setLegacyCount] = useState(0);
  const [active, setActive] = useState<ActiveTab | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pinnedAgents, setPinnedAgents] = useState<PinnedAgent[]>([]);
  const [debugMode, setDebugMode] = useState(false);
  // Files queued in the composer, waiting to be sent with the next message.
  // Cleared on successful send. Shown as chips above the textarea.
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Per-session streaming + message state. Keyed by session id (or "legacy").
  const [sessionStates, setSessionStates] = useState<
    Record<string, SessionState>
  >({});
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // The scrollable element inside Virtuoso. Captured via the `scrollerRef`
  // prop so the live-bubble follow effect (below) can scroll past Virtuoso's
  // last data item into the Footer where the streaming reply renders.
  const scrollerRef = useRef<HTMLElement | null>(null);
  // True when the user is at (or near) the bottom of the transcript. Virtuoso
  // owns the scroll element + auto-follow logic; this ref mirrors its
  // atBottomStateChange callback so other code (e.g. send()) can decide
  // whether to snap.
  const stickToBottomRef = useRef(true);
  // Cleanup for the listeners attached when Virtuoso hands us the scroll
  // element via scrollerRef. Set inside the scrollerRef callback.
  const scrollerCleanupRef = useRef<(() => void) | null>(null);
  // Imperative handle to the composer's textarea — lets the parent prefill
  // text or move focus without owning the per-keystroke draft state, which
  // would otherwise re-render the entire transcript on every keypress.
  const composerRef = useRef<ComposerHandle>(null);
  // Ref mirror so the unmount cleanup can reach live controllers without re-running.
  const sessionStatesRef = useRef(sessionStates);
  useEffect(() => {
    sessionStatesRef.current = sessionStates;
  }, [sessionStates]);
  // Mirror of `active` for handlers (visibility, reattach loop) that must not
  // re-run when the active tab changes.
  const activeRef = useRef<ActiveTab | null>(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  const activeState = active != null ? sessionStates[active] : null;
  const messages = activeState?.messages ?? [];
  const live = activeState?.live ?? null;
  const error = activeState?.error ?? null;
  const sending = !!activeState?.controller;
  const queuedCount = activeState?.queuedCount ?? 0;

  const patchSession = useCallback(
    (key: string, patch: Partial<SessionState>) => {
      setSessionStates((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? emptySessionState()), ...patch },
      }));
    },
    []
  );

  // Agents available to start a chat with in this env. Excludes agents the
  // team has disabled here. Server already orders pinned first.
  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/envs/${envId}/agents`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: PinnedAgent[]) =>
        setPinnedAgents(data.filter((a) => !a.disabledInEnv))
      )
      .catch(() => {});
  }, [workspaceId, envId]);

  // Debug mode flag (workspace-level). When on, the chat UI shows a live debug
  // panel with SDK events and a meta summary.
  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}/settings/integrations`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.debugMode === "boolean") {
          setDebugMode(data.debugMode);
        }
      })
      .catch(() => {});
  }, [workspaceId]);

  // Onboarding banner dismissed-state — persisted per env so a returning user
  // doesn't see it again. Initial state read in an effect (not at render) to
  // stay SSR-safe.
  const onboardingKey = `withvibe.onboarding.dismissed:${envId}`;
  const [onboardingDismissed, setOnboardingDismissed] = useState(true);
  useEffect(() => {
    try {
      setOnboardingDismissed(
        window.localStorage.getItem(onboardingKey) === "1"
      );
    } catch {
      // localStorage unavailable (private mode) — leave dismissed=true so the
      // banner stays out of the way rather than nagging on every reload.
    }
  }, [onboardingKey]);
  function dismissOnboarding() {
    setOnboardingDismissed(true);
    try {
      window.localStorage.setItem(onboardingKey, "1");
    } catch {
      /* ignore */
    }
  }

  // Prefill handler (from Ask-AI-to-generate button upstream).
  useEffect(() => {
    if (!prefill || !prefill.text) return;
    composerRef.current?.setDraft(prefill.text);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.scrollIntoView({ block: "nearest" });
    });
  }, [prefill?.id, prefill?.text]);

  // Load sessions on mount / env switch.
  const loadSessions = useCallback(async () => {
    const res = await fetch(
      `/api/workspaces/${workspaceId}/envs/${envId}/sessions`
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      sessions: Session[];
      legacyCount: number;
    };
    setSessions(data.sessions);
    setLegacyCount(data.legacyCount);

    setActive((prev) => {
      if (prev) return prev;
      if (data.sessions.length > 0) return data.sessions[0].id;
      if (data.legacyCount > 0) return "legacy";
      return null;
    });
  }, [workspaceId, envId]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Load stored messages for a specific session key (idempotent via messagesLoaded flag).
  const loadMessages = useCallback(
    async (key: string) => {
      const url = new URL(
        `/api/workspaces/${workspaceId}/envs/${envId}/messages`,
        window.location.origin
      );
      url.searchParams.set("sessionId", key);
      const res = await fetch(url.pathname + url.search);
      if (!res.ok) return;
      const data = (await res.json()) as StoredMessage[];
      setSessionStates((prev) => {
        const cur = prev[key] ?? emptySessionState();
        return {
          ...prev,
          [key]: { ...cur, messages: data, messagesLoaded: true },
        };
      });
    },
    [workspaceId, envId]
  );

  // Lazy-load messages for the active session on first visit.
  useEffect(() => {
    if (active == null) return;
    const state = sessionStatesRef.current[active];
    if (state?.messagesLoaded || state?.controller) return;
    loadMessages(active);
  }, [active, loadMessages]);

  // Switching sessions resets the read position — snap to bottom and re-stick.
  // Virtuoso owns auto-follow during streaming via `followOutput` below.
  useEffect(() => {
    stickToBottomRef.current = true;
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [active]);

  // Follow happens via ResizeObserver attached in the scrollerRef callback —
  // it reacts to any content height change (live reply growing, tool boxes
  // appearing, images loading) regardless of React's render cadence.
  useEffect(() => {
    return () => {
      scrollerCleanupRef.current?.();
      scrollerCleanupRef.current = null;
    };
  }, []);

  // Unsubscribe from (but don't cancel) any in-flight streams on unmount.
  // Aborting the fetch only closes our client-side subscription — the
  // backend run keeps going and can be reattached when we come back.
  useEffect(() => {
    return () => {
      for (const s of Object.values(sessionStatesRef.current)) {
        s.controller?.abort();
      }
    };
  }, []);

  // When the tab becomes visible again (e.g. laptop wake), the SSE stream
  // we were holding may have been terminated by the browser while we slept.
  // Pull the freshest DB state for the active session and bump the reattach
  // loop so it re-checks for an in-flight run. Without this, a run that
  // completed during sleep stays invisible until the user navigates away.
  useEffect(() => {
    function onVisible() {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      const activeKey = activeRef.current;
      if (activeKey) void loadMessages(activeKey).catch(() => {});
      void loadSessions().catch(() => {});
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loadMessages, loadSessions]);

  // Reattach to any active run for the *current session* (after navigation
  // back, page reload, or transient SSE drop). The run lives on the server;
  // we just re-subscribe to its event stream. Keeps looping while a run is
  // alive so that transient drops (proxy timeout, network blip) auto-heal.
  // Re-runs whenever the active session changes — different sessions have
  // independent runs (Claude-Code-style: per-session lock, shared cwd).
  useEffect(() => {
    if (!active || active === "legacy") return;
    const sessionId = active;
    let cancelled = false;
    async function reattachLoop() {
      while (!cancelled) {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/envs/${envId}/messages/active-run?sessionId=${encodeURIComponent(sessionId)}`
        ).catch(() => null);
        if (cancelled) return;
        if (!res || !res.ok) {
          await sleep(2000);
          continue;
        }
        const data = (await res.json().catch(() => null)) as
          | { status: "idle" }
          | {
              status: "running" | "done" | "error" | "interrupted";
              runId: string;
              sessionId: string;
              startedAt: string;
              queuedCount: number;
            }
          | null;
        if (cancelled || !data) return;
        // Run already finished (or none in flight): pull the latest messages
        // from the DB for whichever session is active. This is what catches
        // the "computer slept while the AI replied" case — we missed the
        // live stream, but the assistant message is in the DB now.
        if (data.status !== "running") {
          await loadMessages(sessionId).catch(() => {});
          return;
        }
        // If we're already consuming this stream (e.g. from send()), skip.
        if (sessionStatesRef.current[sessionId]?.controller) return;
        await loadMessages(sessionId);
        if (cancelled) return;
        const controller = new AbortController();
        setSessionStates((prev) => {
          const cur = prev[sessionId] ?? emptySessionState();
          return {
            ...prev,
            [sessionId]: {
              ...cur,
              controller,
              // Reset `live` to empty — never preserve `cur.live` here. The
              // backend's subscribe() replays the *entire* current-turn event
              // buffer from the start (no since-cursor), so the stream we're
              // about to consume reconstructs the live block in full. Keeping
              // the old `live` would double every already-rendered text/tool
              // segment, since the replay's text/tool_use events are appended
              // without dedup. Safe to reset: reattach only runs when no
              // stream is actively being consumed (guarded above).
              live: {
                content: "",
                thinking: "",
                toolCalls: [],
                segments: [],
                debug: emptyDebugState(),
              },
              error: null,
              queuedCount: data.queuedCount,
            },
          };
        });
        const streamRes = await fetch(
          `/api/workspaces/${workspaceId}/envs/${envId}/messages/active-run/stream?sessionId=${encodeURIComponent(sessionId)}`,
          { signal: controller.signal }
        ).catch(() => null);
        if (cancelled) return;
        if (!streamRes || !streamRes.ok || !streamRes.body) {
          patchSession(sessionId, { controller: null, live: null });
          await sleep(2000);
          continue;
        }
        const { ended } = await consumeStream(sessionId, streamRes, controller);
        if (ended || cancelled) return;
        // Stream dropped without `run_ended` — loop back and re-check the
        // server. If the run is still active we'll re-subscribe.
        await sleep(1000);
      }
    }
    void reattachLoop();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, envId, active]);

  async function createSessionApi(
    agentId: string | null
  ): Promise<Session | null> {
    const res = await fetch(
      `/api/workspaces/${workspaceId}/envs/${envId}/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(agentId ? { agentId } : {}),
      }
    );
    if (!res.ok) return null;
    return (await res.json()) as Session;
  }

  async function newSession(agentId: string | null = null) {
    const s = await createSessionApi(agentId);
    if (!s) return;
    setSessions((prev) => [s, ...(prev || [])]);
    setActive(s.id);
    // Seed empty state so lazy-load doesn't trip.
    setSessionStates((prev) => ({
      ...prev,
      [s.id]: { ...emptySessionState(), messagesLoaded: true },
    }));
  }

  async function openAgentSession(agentId: string) {
    const existing = (sessions || []).find((s) => s.agent?.id === agentId);
    if (existing) {
      setActive(existing.id);
      return;
    }
    await newSession(agentId);
  }

  async function deleteSession(id: string) {
    if (!confirm("Delete this session and all its messages?")) return;
    // Abort any in-flight stream for this session first.
    sessionStates[id]?.controller?.abort();
    const res = await fetch(
      `/api/workspaces/${workspaceId}/envs/${envId}/sessions/${id}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      toast.error("Failed to delete session");
      return;
    }
    toast.success("Session deleted");
    setSessions((prev) => (prev || []).filter((s) => s.id !== id));
    setSessionStates((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (active === id) {
      const remaining = (sessions || []).filter((s) => s.id !== id);
      if (remaining.length > 0) setActive(remaining[remaining.length - 1].id);
      else if (legacyCount > 0) setActive("legacy");
      else setActive(null);
    }
  }

  async function renameSession(id: string) {
    const current = (sessions || []).find((s) => s.id === id);
    const next = prompt("Rename session", current?.title || "");
    if (next === null) return;
    const res = await fetch(
      `/api/workspaces/${workspaceId}/envs/${envId}/sessions/${id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: next }),
      }
    );
    if (!res.ok) {
      toast.error("Failed to rename");
      return;
    }
    setSessions((prev) =>
      (prev || []).map((s) => (s.id === id ? { ...s, title: next || null } : s))
    );
  }

  // Append-and-clamp helper used by the file picker, drag-drop, and paste.
  // Validates types/size client-side so the user gets immediate feedback
  // instead of a 400 after a slow upload. Mirrors the server whitelist.
  const enqueueFiles = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;
      setPendingFiles((prev) => {
        const next = [...prev];
        for (const f of incoming) {
          if (next.length >= MAX_ATTACHMENT_FILES) {
            toast.error(`Max ${MAX_ATTACHMENT_FILES} files per message`);
            break;
          }
          if (f.size > MAX_ATTACHMENT_FILE_BYTES) {
            toast.error(`"${f.name}" is over 25 MB`);
            continue;
          }
          if (!isAttachmentTypeAllowed(f)) {
            toast.error(`"${f.name}" — type ${f.type || "unknown"} not allowed`);
            continue;
          }
          next.push(f);
        }
        return next;
      });
    },
    []
  );

  function removePendingFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }

  // The composer owns the draft text and clears itself on submit; suggestion
  // pills pass their own text. Either way we only get the trimmed content.
  async function send(text: string) {
    const trimmed = text.trim();
    // A send must carry text or at least one attachment.
    if (!trimmed && pendingFiles.length === 0) return;
    const content = trimmed;
    const filesToSend = pendingFiles;
    // Resolve the stream key up-front so multi-session tracking has a stable id.
    // If we're on legacy or have no session, create a fresh one first.
    let streamKey: string;
    if (active == null || active === "legacy") {
      const s = await createSessionApi(null);
      if (!s) {
        toast.error("Couldn't start a new session");
        return;
      }
      setSessions((prev) => [s, ...(prev || [])]);
      setActive(s.id);
      setSessionStates((prev) => ({
        ...prev,
        [s.id]: { ...emptySessionState(), messagesLoaded: true },
      }));
      streamKey = s.id;
    } else {
      streamKey = active;
    }

    // If a turn is already streaming for this session, the server queues the
    // new message and dispatches it as the next turn (Claude-Code-style).
    // Don't open a second SSE stream — the existing one will surface the
    // user_saved + queued events for the new message.
    const alreadyStreaming = !!sessionStates[streamKey]?.controller;

    setPendingFiles([]);
    const controller = alreadyStreaming
      ? sessionStates[streamKey]!.controller!
      : new AbortController();

    // Optimistic attachment chips — rendered without an `id` so we know to
    // skip the download link until the server-issued row replaces them on
    // the post-stream `loadMessages` refresh.
    const optimisticAttachments: StoredAttachment[] = filesToSend.map((f) => ({
      id: "",
      mime: f.type,
      size: f.size,
      originalName: f.name,
    }));

    setSessionStates((prev) => {
      const cur = prev[streamKey] ?? emptySessionState();
      // When queueing into an in-flight turn, keep the existing live block
      // (it's still streaming the current assistant reply) and bump the
      // queued counter optimistically. The server will confirm with a
      // `queued` event soon after.
      return {
        ...prev,
        [streamKey]: {
          ...cur,
          controller,
          live: alreadyStreaming
            ? cur.live
            : {
                content: "",
                thinking: "",
                toolCalls: [],
                segments: [],
                debug: emptyDebugState(),
              },
          error: null,
          queuedCount: alreadyStreaming
            ? cur.queuedCount + 1
            : cur.queuedCount,
          messages: [
            ...cur.messages,
            {
              id: `optimistic-${Date.now()}`,
              role: "user",
              content,
              metadata: null,
              createdAt: new Date().toISOString(),
              sessionId: streamKey,
              attachments: optimisticAttachments,
            },
          ],
        },
      };
    });

    try {
      // Multipart when files are attached — Multer's FilesInterceptor on the
      // server reads `files`, `content`, and `sessionId` fields. Plain JSON
      // path is preserved for the (common) text-only case.
      let init: RequestInit;
      if (filesToSend.length > 0) {
        const fd = new FormData();
        fd.append("content", content);
        fd.append("sessionId", streamKey);
        for (const f of filesToSend) fd.append("files", f, f.name);
        init = { method: "POST", body: fd, signal: controller.signal };
      } else {
        init = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, sessionId: streamKey }),
          signal: controller.signal,
        };
      }
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/messages`,
        init
      );

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "Failed to send");
        if (alreadyStreaming) {
          // A queue attempt failed — keep the live stream intact, just
          // surface the error and back out the optimistic queue bump.
          setSessionStates((prev) => {
            const cur = prev[streamKey];
            if (!cur) return prev;
            return {
              ...prev,
              [streamKey]: {
                ...cur,
                error: errText,
                queuedCount: Math.max(0, cur.queuedCount - 1),
              },
            };
          });
        } else {
          patchSession(streamKey, {
            error: errText,
            live: null,
            controller: null,
          });
        }
        return;
      }

      // When queueing into an in-flight turn, the existing SSE consumer is
      // already running — we drain (and discard) this response body so the
      // server can finish flushing, but events come through the existing
      // controller. Otherwise we attach the consumer to the new stream.
      if (alreadyStreaming) {
        void res.body.cancel().catch(() => {});
      } else {
        await consumeStream(streamKey, res, controller);
      }
    } catch (err) {
      const aborted = (err as { name?: string })?.name === "AbortError";
      if (alreadyStreaming) {
        if (!aborted) {
          setSessionStates((prev) => {
            const cur = prev[streamKey];
            if (!cur) return prev;
            return {
              ...prev,
              [streamKey]: {
                ...cur,
                error: err instanceof Error ? err.message : String(err),
                queuedCount: Math.max(0, cur.queuedCount - 1),
              },
            };
          });
        }
      } else {
        patchSession(streamKey, {
          error: aborted ? null : err instanceof Error ? err.message : String(err),
          live: null,
          controller: null,
        });
      }
    }
  }

  // Read SSE frames from `res.body` and dispatch them. Resolves with
  // `{ ended }` — true means the server sent `run_ended`, false means the
  // stream closed unexpectedly (client abort, network error, proxy timeout).
  // Client abort only unsubscribes; the backend run keeps going, and the
  // caller can re-check active-run and reattach.
  const consumeStream = useCallback(
    async (
      streamKey: string,
      res: Response,
      controller: AbortController
    ): Promise<{ ended: boolean }> => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ended = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() || "";
          for (const raw of events) {
            // SSE comment frames (our keepalive) start with ":" — skip them.
            if (!raw.startsWith("data:")) continue;
            const json = raw.slice(5).trim();
            if (!json) continue;
            try {
              const ev = JSON.parse(json);
              if (ev.type === "session_idle") {
                // Final frame — server has no more queued turns. Close.
                ended = true;
              } else {
                handleEventFor(streamKey, ev);
              }
            } catch {}
          }
          if (ended) break;
        }
      } catch (err) {
        const aborted =
          controller.signal.aborted ||
          (err as { name?: string })?.name === "AbortError";
        if (!aborted) {
          console.warn("[chat] stream read error:", err);
        }
      } finally {
        if (ended) {
          await loadSessions().catch(() => {});
          await loadMessages(streamKey).catch(() => {});
        }
        patchSession(streamKey, { live: null, controller: null, queuedCount: 0 });
      }
      return { ended };
    },
    [loadSessions, loadMessages, patchSession]
  );

  function handleEventFor(
    streamKey: string,
    ev: {
      type: string;
      delta?: string;
      name?: string;
      input?: unknown;
      /** tool_use_id from a `tool_use` event (Phase 1b — used to correlate latency back to the card). */
      id?: string;
      /** tool_use_id from a `debug_tool_latency` event. */
      toolUseId?: string;
      /** True on tool_result + debug_tool_latency when the tool errored. */
      isError?: boolean;
      message?: string;
      sdkType?: string;
      sdkSubtype?: string;
      sinceStartMs?: number;
      sinceLastMs?: number;
      summary?: string;
      queuedCount?: number;
      status?: string;
      auto?: boolean;
      tier?: string;
    } & Partial<DebugMeta>
  ) {
    // Queue tracking and turn-boundary events don't depend on `live`, so
    // handle them up front before bailing out for messages without a live.
    if (ev.type === "queued" && typeof ev.queuedCount === "number") {
      const count = ev.queuedCount;
      setSessionStates((prev) => {
        const cur = prev[streamKey];
        if (!cur) return prev;
        return { ...prev, [streamKey]: { ...cur, queuedCount: count } };
      });
      return;
    }
    if (ev.type === "run_started") {
      // A new turn (auto-dispatched from the queue) is starting — reset the
      // live block so the next assistant reply renders fresh, and decrement
      // the queued counter (the message we just dequeued is now running).
      // The previous turn's assistant message was already appended locally
      // on its `run_ended`, so no refetch is needed here.
      setSessionStates((prev) => {
        const cur = prev[streamKey];
        if (!cur) return prev;
        return {
          ...prev,
          [streamKey]: {
            ...cur,
            live: {
              content: "",
              thinking: "",
              toolCalls: [],
              segments: [],
              debug: emptyDebugState(),
            },
            queuedCount: Math.max(0, cur.queuedCount - 1),
          },
        };
      });
      return;
    }
    if (ev.type === "run_ended") {
      // Snapshot the live block as a stored assistant message so the UI
      // doesn't lose it when `live` resets on the next run_started. The
      // session's `finally` cleanup runs `loadMessages` once at session_idle
      // to reconcile our locally-appended message with the real DB id.
      setSessionStates((prev) => {
        const cur = prev[streamKey];
        if (!cur || !cur.live) return prev;
        const live = cur.live;
        if (!live.content && live.segments.length === 0) return prev;
        const stored: StoredMessage = {
          id: `local-${Date.now()}`,
          role: "assistant",
          content: live.content,
          metadata: {
            segments: live.segments,
            toolCalls: live.toolCalls,
            thinking: live.thinking || undefined,
            debugEvents: live.debug.events.length ? live.debug.events : undefined,
            debugMeta: live.debug.meta ?? undefined,
            debugToolLatencies: Object.keys(live.debug.toolLatencies).length
              ? live.debug.toolLatencies
              : undefined,
          },
          createdAt: new Date().toISOString(),
          sessionId: streamKey,
        };
        return {
          ...prev,
          [streamKey]: {
            ...cur,
            messages: [...cur.messages, stored],
            live: null,
          },
        };
      });
      return;
    }
    setSessionStates((prev) => {
      const cur = prev[streamKey];
      if (!cur || !cur.live) return prev;
      let live = cur.live;
      let error = cur.error;
      if (ev.type === "text" && typeof ev.delta === "string") {
        const delta = ev.delta;
        const last = live.segments[live.segments.length - 1];
        const nextSegments: MessageSegment[] =
          last && last.type === "text"
            ? [
                ...live.segments.slice(0, -1),
                { type: "text", text: last.text + delta },
              ]
            : [...live.segments, { type: "text", text: delta }];
        live = {
          ...live,
          content: live.content + delta,
          segments: nextSegments,
        };
      } else if (ev.type === "thinking" && typeof ev.delta === "string") {
        live = { ...live, thinking: live.thinking + ev.delta };
      } else if (ev.type === "tool_use" && ev.name) {
        const id = typeof ev.id === "string" ? ev.id : undefined;
        const seg: MessageSegment = {
          type: "tool_use",
          name: ev.name,
          input: ev.input,
          id,
        };
        live = {
          ...live,
          toolCalls: [
            ...live.toolCalls,
            { name: ev.name, input: ev.input, id },
          ],
          segments: [...live.segments, seg],
        };
      } else if (
        ev.type === "debug_tool_latency" &&
        typeof ev.toolUseId === "string"
      ) {
        live = {
          ...live,
          debug: {
            ...live.debug,
            toolLatencies: {
              ...live.debug.toolLatencies,
              [ev.toolUseId]: {
                name: typeof ev.name === "string" ? ev.name : "",
                durationMs:
                  typeof ev.durationMs === "number" ? ev.durationMs : 0,
                isError: ev.isError,
              },
            },
          },
        };
      } else if (
        ev.type === "debug_sdk_event" &&
        typeof ev.sdkType === "string"
      ) {
        const entry: DebugSdkEvent = {
          sdkType: ev.sdkType,
          sdkSubtype: ev.sdkSubtype,
          sinceStartMs: ev.sinceStartMs ?? 0,
          sinceLastMs: ev.sinceLastMs ?? 0,
          summary: ev.summary,
        };
        live = {
          ...live,
          debug: { ...live.debug, events: [...live.debug.events, entry] },
        };
      } else if (ev.type === "debug_routed_model" && typeof ev.model === "string") {
        const routedModel: RoutedModel = {
          model: ev.model,
          auto: ev.auto ?? false,
          tier: ev.tier,
        };
        live = { ...live, debug: { ...live.debug, routedModel } };
      } else if (ev.type === "debug_meta") {
        const meta: DebugMeta = {
          model: ev.model,
          numTurns: ev.numTurns,
          durationMs: ev.durationMs,
          durationApiMs: ev.durationApiMs,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          cacheCreationTokens: ev.cacheCreationTokens,
          cacheReadTokens: ev.cacheReadTokens,
          totalCostUsd: ev.totalCostUsd,
          toolCallsByName: ev.toolCallsByName ?? {},
          userPrompt: ev.userPrompt,
          systemAppend: ev.systemAppend,
          systemPresetNote: ev.systemPresetNote,
        };
        live = { ...live, debug: { ...live.debug, meta } };
      } else if (ev.type === "error") {
        error = ev.message || "AI error";
      }
      return { ...prev, [streamKey]: { ...cur, live, error } };
    });
  }

  // Stop the current turn server-side. The server aborts the engine and
  // drops anything queued behind it (Claude-Code-style interrupt — the user
  // pressed stop, so they don't want their queue auto-firing either).
  async function interrupt() {
    if (active == null || active === "legacy") return;
    const sessionId = active;
    try {
      await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/messages/interrupt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId }),
        }
      );
    } catch {
      // The SSE stream will surface the actual outcome — `run_ended` with
      // status: "interrupted" or an `error` event. Ignore network blips.
    }
  }

  const sessionTabs = useMemo(() => {
    const tabs: {
      id: ActiveTab;
      label: string;
      canMenu: boolean;
      agent: AgentSummary | null;
    }[] = [];
    if (legacyCount > 0) {
      tabs.push({ id: "legacy", label: "Legacy", canMenu: false, agent: null });
    }
    for (const s of sessions || []) {
      // Agent-tagged sessions live in the Agents section, not in History.
      if (s.agent) continue;
      tabs.push({
        id: s.id,
        label: s.title || "New session",
        canMenu: true,
        agent: s.agent,
      });
    }
    return tabs;
  }, [sessions, legacyCount]);

  const activeLabel =
    active === "legacy"
      ? "Legacy messages"
      : sessions?.find((s) => s.id === active)?.title || "New session";

  const activeAgentSlug =
    active && active !== "legacy"
      ? (sessions?.find((s) => s.id === active)?.agent?.slug ?? null)
      : null;

  // Show suggestion buttons only on the most recent assistant message that
  // carries suggestions, and only while no user reply follows.
  const latestSuggestionMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user") return null;
      if (m.role === "assistant" && m.metadata?.suggestions?.length) return m.id;
    }
    return null;
  }, [messages]);

  return (
    <Card className="!flex-row h-full w-full min-h-[420px] min-w-0 py-0 gap-0 overflow-hidden">
      {/* Sessions sidebar (inside the chat card) */}
      {!sidebarCollapsed && (
        <aside className="w-56 shrink-0 border-r border-border/60 bg-muted/20 flex flex-col">
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/60 shrink-0">
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              onClick={() => setSidebarCollapsed(true)}
              title="Collapse sessions"
            >
              <PanelLeftClose className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 gap-1 h-7 text-[11px] font-mono"
              onClick={() => newSession(null)}
            >
              <Plus className="size-3" />
              New chat
            </Button>
          </div>

          {pinnedAgents.length > 0 && (
            <div className="border-b border-border/60 py-1.5 shrink-0">
              <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Agents
              </div>
              <ul className="space-y-0.5 px-1">
                {pinnedAgents.map((a) => {
                  const agentSession = (sessions || []).find(
                    (s) => s.agent?.id === a.id
                  );
                  const isActive =
                    agentSession != null && active === agentSession.id;
                  const isStreaming =
                    agentSession != null &&
                    !!sessionStates[agentSession.id]?.controller;
                  return (
                    <li
                      key={a.id}
                      className={cn(
                        "group flex items-center gap-1.5 rounded-md px-2 py-1.5 cursor-pointer transition-smooth",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted text-foreground/80"
                      )}
                      onClick={() => openAgentSession(a.id)}
                      title={`Open chat with ${a.name}`}
                    >
                      <Bot className="size-3.5 shrink-0 text-primary" />
                      <span className="flex-1 min-w-0 truncate text-[11px] font-mono">
                        {a.name}
                      </span>
                      {isStreaming && (
                        <Loader2
                          className="size-3 shrink-0 text-primary animate-spin"
                          aria-label="Thinking…"
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
            <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              History
            </div>
            {sessionTabs.length === 0 ? (
              <p className="px-3 py-3 text-[11px] font-mono text-muted-foreground">
                No sessions yet — send a message to start.
              </p>
            ) : (
              <ul className="space-y-0.5 px-1">
                {sessionTabs.map((t) => {
                  const isActive = active === t.id;
                  const isStreaming = !!sessionStates[t.id]?.controller;
                  return (
                    <li
                      key={t.id}
                      className={cn(
                        "group flex items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer transition-smooth",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "hover:bg-muted text-foreground/80"
                      )}
                      onClick={() => setActive(t.id)}
                    >
                      {t.agent ? (
                        <Bot
                          className="size-3 shrink-0 text-muted-foreground"
                          aria-label={`Agent: ${t.agent.name}`}
                        />
                      ) : (
                        <Sparkles className="size-3 shrink-0 text-muted-foreground/60" />
                      )}
                      <span className="flex-1 min-w-0 truncate text-[11px] font-mono">
                        {t.label}
                      </span>
                      {isStreaming && (
                        <Loader2
                          className="size-3 shrink-0 text-primary animate-spin"
                          aria-label="Thinking…"
                        />
                      )}
                      {t.canMenu && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                size="icon"
                                variant="ghost"
                                className={cn(
                                  "size-5 shrink-0",
                                  isActive
                                    ? "opacity-100"
                                    : "opacity-0 group-hover:opacity-100"
                                )}
                                onClick={(e) => e.stopPropagation()}
                                title="Session actions"
                              />
                            }
                          >
                            <MoreVertical className="size-3" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="start">
                            <DropdownMenuItem
                              onClick={() => renameSession(t.id)}
                            >
                              Rename
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => deleteSession(t.id)}
                              className="text-destructive"
                            >
                              <Trash2 className="size-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>
      )}

      {/* Main chat column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top bar — expand toggle + active session label + working indicator */}
        <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/60 h-10 shrink-0">
          {sidebarCollapsed && (
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              onClick={() => setSidebarCollapsed(false)}
              title="Show sessions"
            >
              <PanelLeftOpen className="size-3.5" />
            </Button>
          )}
          <span className="flex-1 min-w-0 truncate text-[11px] font-mono text-muted-foreground">
            {active ? activeLabel : "No session"}
          </span>
          {activeAgentSlug === "security" && onRunSecurityScan && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-[11px]"
              onClick={onRunSecurityScan}
              title="Run an automated security scan of this env's code changes"
            >
              <ScanLine className="size-3" />
              Run security scan
            </Button>
          )}
          {sending && (
            <span className="shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/30 text-[11px] font-mono">
              <Loader2 className="size-3 animate-spin" />
              AI is working…
              {queuedCount > 0 && (
                <span className="text-[10px] text-primary/70">
                  · {queuedCount} queued
                </span>
              )}
            </span>
          )}
          {debugMode && sending && live?.debug.routedModel && (
            <span
              className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border text-[11px] font-mono"
              title={
                live.debug.routedModel.auto
                  ? `Auto-routed${live.debug.routedModel.tier ? ` (tier: ${live.debug.routedModel.tier})` : ""}`
                  : "Pinned model (workspace/env setting)"
              }
            >
              {live.debug.routedModel.model}
              {live.debug.routedModel.auto && (
                <span className="text-[10px] opacity-70">
                  · auto{live.debug.routedModel.tier ? `→${live.debug.routedModel.tier}` : ""}
                </span>
              )}
            </span>
          )}
        </div>

        {/* First-env onboarding banner. Shown when the active session has
            exactly one message (the pre-persisted DevOps greeting) and no
            user reply yet, OR when there are no messages at all on a fresh
            session. Auto-disappears after the user sends their first
            message; can also be dismissed manually. */}
        {!onboardingDismissed &&
          !messages.some((m) => m.role === "user") &&
          !live && (
            <div className="mx-4 mt-2 mb-1 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 flex items-start gap-2 text-sm">
              <Sparkles className="size-4 text-primary mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium">
                  Talk to DevOps below to start your environment
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Try “Start the env” or “Set up the database”. DevOps will
                  walk you through what this env needs.
                </p>
              </div>
              <button
                type="button"
                onClick={dismissOnboarding}
                className="text-muted-foreground hover:text-foreground transition-smooth shrink-0"
                title="Dismiss"
                aria-label="Dismiss onboarding hint"
              >
                <X className="size-4" />
              </button>
            </div>
          )}

        {messages.length === 0 && !live ? (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="p-6 text-center py-12 space-y-3">
              <div className="mx-auto flex size-10 items-center justify-center rounded-md bg-primary/10 text-primary border border-primary/20">
                <Sparkles className="size-5" />
              </div>
              <div>
                <p className="font-mono font-semibold">Start chatting</p>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto mt-1">
                  The AI knows you, your team, this environment, and the
                  attached repos.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            scrollerRef={(ref) => {
              const el = ref instanceof HTMLElement ? ref : null;
              if (scrollerRef.current === el) return;
              if (scrollerCleanupRef.current) {
                scrollerCleanupRef.current();
                scrollerCleanupRef.current = null;
              }
              scrollerRef.current = el;
              if (!el) return;
              // The native scroll event only fires when scrollTop actually
              // changes — not when scrollHeight grows because the Footer
              // expanded. So manual user scrolling updates stickToBottomRef,
              // but Footer growth (live reply, new tool segments) doesn't
              // wrongly flip it to false.
              const onScroll = () => {
                stickToBottomRef.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              };
              el.addEventListener("scroll", onScroll);
              // ResizeObserver fires whenever the content's height changes
              // (live deltas, tool boxes appearing, images loading). When
              // the user is pinned to the bottom, snap to the new bottom so
              // the latest text never falls below the visible area.
              const ro = new ResizeObserver(() => {
                if (!stickToBottomRef.current) return;
                el.scrollTop = el.scrollHeight;
              });
              const content = el.firstElementChild;
              if (content instanceof HTMLElement) ro.observe(content);
              scrollerCleanupRef.current = () => {
                el.removeEventListener("scroll", onScroll);
                ro.disconnect();
              };
            }}
            className="flex-1 min-h-0"
            data={messages}
            atBottomThreshold={40}
            followOutput={() =>
              stickToBottomRef.current ? "smooth" : false
            }
            initialTopMostItemIndex={Math.max(0, messages.length - 1)}
            increaseViewportBy={{ top: 400, bottom: 400 }}
            components={{
              Header: () => <div className="h-6" />,
              Footer: () => (
                // Generous bottom padding so the last bubble + the live reply
                // never sit flush against the composer — keeps the text
                // visible above the input box at all scroll positions.
                <div className="px-6 pb-16 space-y-5">
                  {live && <LiveBubble live={live} debugMode={debugMode} />}
                  {error && (
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}
                </div>
              ),
            }}
            itemContent={(_index, m) => (
              <div className="px-6 pb-5 flex flex-col">
                <MessageBubble
                  message={m}
                  debugMode={debugMode}
                  workspaceId={workspaceId}
                  envId={envId}
                />
                {m.id === latestSuggestionMessageId && !live && !sending && (
                  <SuggestionButtons
                    suggestions={m.metadata?.suggestions ?? []}
                    onPick={(s) => {
                      if (s.toLowerCase().startsWith("other")) {
                        composerRef.current?.focus();
                        return;
                      }
                      void send(s);
                    }}
                  />
                )}
              </div>
            )}
          />
        )}

        <div
          className={cn(
            "border-t border-border/60 p-3 shrink-0 transition-colors",
            isDragging && "bg-primary/5"
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            // Only clear when leaving the composer itself, not its children.
            if (e.currentTarget === e.target) setIsDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const dropped = Array.from(e.dataTransfer.files ?? []);
            enqueueFiles(dropped);
          }}
        >
          {pendingFiles.length > 0 && (
            <PendingAttachmentRow
              files={pendingFiles}
              onRemove={removePendingFile}
              disabled={false}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              enqueueFiles(picked);
              // Reset so picking the same file again still fires onChange.
              e.target.value = "";
            }}
          />
          <Composer
            ref={composerRef}
            sending={sending}
            hasPendingFiles={pendingFiles.length > 0}
            onSend={(text) => void send(text)}
            onInterrupt={interrupt}
            onAttachClick={() => fileInputRef.current?.click()}
            onPasteFiles={enqueueFiles}
          />
        </div>
      </div>
    </Card>
  );
}

type ComposerHandle = {
  setDraft: (text: string) => void;
  focus: () => void;
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
};

// Owns the per-keystroke `draft` state so typing doesn't re-render the parent
// transcript. The parent reads the text only on submit (via `onSend`) and can
// imperatively prefill / focus through the forwarded ref.
const Composer = forwardRef<
  ComposerHandle,
  {
    sending: boolean;
    hasPendingFiles: boolean;
    onSend: (text: string) => void;
    onInterrupt: () => void;
    onAttachClick: () => void;
    onPasteFiles: (files: File[]) => void;
  }
>(function Composer(props, ref) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      setDraft: (text: string) => setDraft(text),
      focus: () => textareaRef.current?.focus(),
      scrollIntoView: (options) => textareaRef.current?.scrollIntoView(options),
    }),
    []
  );

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 || props.hasPendingFiles;

  function submit() {
    if (!canSend) return;
    props.onSend(draft);
    setDraft("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex gap-2 items-end">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-10 shrink-0"
        onClick={props.onAttachClick}
        title="Attach files"
      >
        <Paperclip className="size-4" />
      </Button>
      <Textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData?.files ?? []);
          if (pasted.length === 0) return;
          e.preventDefault();
          props.onPasteFiles(pasted);
        }}
        rows={2}
        dir="auto"
        placeholder={
          props.sending
            ? "AI is working — your next message will be queued"
            : "Ask anything about this environment…  (Enter to send, Shift+Enter for new line)"
        }
        className="resize-none bg-muted/40"
      />
      {props.sending && !canSend ? (
        <Button
          onClick={props.onInterrupt}
          size="icon"
          variant="destructive"
          className="size-10 shrink-0"
          title="Stop the current turn"
        >
          <X className="size-4" />
        </Button>
      ) : (
        <Button
          onClick={submit}
          disabled={!canSend}
          size="icon"
          className="size-10 shrink-0"
          title={props.sending ? "Queue this message" : "Send"}
        >
          <Send className="size-4" />
        </Button>
      )}
    </div>
  );
});

function SuggestionButtons({
  suggestions,
  onPick,
}: {
  suggestions: string[];
  onPick: (value: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {suggestions.map((s) => (
        <Button
          key={s}
          variant="outline"
          size="sm"
          onClick={() => onPick(s)}
          className="h-8 rounded-full"
        >
          {s}
        </Button>
      ))}
    </div>
  );
}

// Strip of chips (or thumbnails for images) shown above the textarea while
// files are queued for the next send. Click × to drop a single file.
function PendingAttachmentRow({
  files,
  onRemove,
  disabled,
}: {
  files: File[];
  onRemove: (index: number) => void;
  disabled: boolean;
}) {
  // Build object URLs for image previews. Revoked when the file leaves the
  // queue or on unmount so we don't leak handles.
  const [previews, setPreviews] = useState<Record<number, string>>({});
  useEffect(() => {
    const next: Record<number, string> = {};
    files.forEach((f, i) => {
      if (f.type.startsWith("image/")) next[i] = URL.createObjectURL(f);
    });
    setPreviews(next);
    return () => {
      for (const url of Object.values(next)) URL.revokeObjectURL(url);
    };
  }, [files]);

  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {files.map((f, i) => {
        const isImage = f.type.startsWith("image/");
        return (
          <div
            key={`${f.name}-${i}`}
            className="group relative flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2 py-1 text-xs font-mono"
          >
            {isImage && previews[i] ? (
              <img
                src={previews[i]}
                alt={f.name}
                className="size-8 rounded object-cover"
              />
            ) : (
              <FileText className="size-4 text-muted-foreground" />
            )}
            <span className="max-w-[160px] truncate">{f.name}</span>
            <span className="text-muted-foreground">
              {formatFileSize(f.size)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-5 shrink-0"
              disabled={disabled}
              onClick={() => onRemove(i)}
              title="Remove"
            >
              <X className="size-3" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// Server-issued attachments rendered inside a message bubble. Images render
// inline via the download route; everything else becomes a download chip.
// Optimistic items (no `id`) are shown without a download link.
function MessageAttachments({
  workspaceId,
  envId,
  attachments,
  isUser,
}: {
  workspaceId: string;
  envId: string;
  attachments: StoredAttachment[];
  isUser: boolean;
}) {
  if (attachments.length === 0) return null;
  return (
    <div
      className={cn(
        "flex flex-wrap gap-2",
        isUser ? "justify-end" : "mb-2"
      )}
    >
      {attachments.map((att, i) => {
        const url = att.id
          ? `/api/workspaces/${workspaceId}/envs/${envId}/attachments/${att.id}`
          : null;
        const isImage = att.mime.startsWith("image/");
        if (isImage && url) {
          return (
            <a
              key={att.id || `opt-${i}`}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="block"
            >
              <img
                src={url}
                alt={att.originalName}
                className="max-h-64 max-w-xs rounded-lg object-cover shadow-sm"
              />
            </a>
          );
        }
        const chip = (
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1 text-xs font-mono">
            <FileText className="size-4 text-muted-foreground" />
            <span className="max-w-[180px] truncate">{att.originalName}</span>
            <span className="text-muted-foreground">
              {formatFileSize(att.size)}
            </span>
          </div>
        );
        return url ? (
          <a
            key={att.id || `opt-${i}`}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="no-underline"
          >
            {chip}
          </a>
        ) : (
          <div key={`opt-${i}`}>{chip}</div>
        );
      })}
    </div>
  );
}

// Memoized so a parent re-render (e.g. from streaming live updates or any
// other state churn) doesn't force every existing bubble to re-parse markdown.
// Each bubble only re-renders if its own `message` reference changes.
const MessageBubble = memo(function MessageBubble({
  message,
  debugMode,
  workspaceId,
  envId,
}: {
  message: StoredMessage;
  debugMode: boolean;
  workspaceId: string;
  envId: string;
}) {
  const isUser = message.role === "user";
  const toolCalls = message.metadata?.toolCalls || [];
  const segments = message.metadata?.segments;
  const thinking = message.metadata?.thinking;
  const debugEvents = message.metadata?.debugEvents;
  const debugMeta = message.metadata?.debugMeta;
  const debugToolLatencies = message.metadata?.debugToolLatencies;
  // Latencies are debug-only signal — pass through to the renderers only when
  // the debug toggle is on, so non-debug viewers never see the timing badges.
  const toolLatencies = debugMode ? debugToolLatencies : undefined;
  const hasDebug = !isUser && debugMode && (debugEvents?.length || debugMeta);
  // New messages carry `segments` (ordered text + tool blocks). Older
  // messages only have the legacy split — fall back to "tools above text".
  const useSegments = !isUser && Array.isArray(segments) && segments.length > 0;
  const userAttachments =
    isUser && message.attachments && message.attachments.length > 0
      ? message.attachments
      : null;

  // User-side render — attachments float *outside* the colored text bubble so
  // images aren't framed by a blue rectangle. The text bubble only appears
  // when there's actual text content (attachment-only messages skip it).
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="flex flex-col items-end gap-2 max-w-[85%]">
          {message.content && (
            <div
              dir="auto"
              className="rounded-md px-4 py-3 text-sm whitespace-pre-wrap bg-primary text-primary-foreground"
            >
              {message.content}
            </div>
          )}
          {userAttachments && (
            <MessageAttachments
              workspaceId={workspaceId}
              envId={envId}
              attachments={userAttachments}
              isUser
            />
          )}
          <MessageTimestamp createdAt={message.createdAt} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="flex flex-col items-start gap-1 max-w-[85%]">
        <div
          className={cn(
            "rounded-md px-4 py-3 text-sm",
            "bg-muted/50 text-foreground border border-border/60"
          )}
        >
          {thinking && <ThinkingBlock text={thinking} />}
          {useSegments ? (
            <SegmentsRenderer
              segments={segments!}
              toolLatencies={toolLatencies}
            />
          ) : (
            <>
              {toolCalls.length > 0 && (
                <ToolCallsList
                  toolCalls={toolCalls}
                  toolLatencies={toolLatencies}
                />
              )}
              <div
                dir="auto"
                className="prose prose-sm prose-invert max-w-none"
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={MARKDOWN_COMPONENTS}
                >
                  {message.content}
                </ReactMarkdown>
              </div>
            </>
          )}
          {hasDebug && (
            <DebugPanel
              debug={{
                events: debugEvents ?? [],
                meta: debugMeta ?? null,
                routedModel: null,
                toolLatencies: debugToolLatencies ?? {},
              }}
            />
          )}
        </div>
        <MessageTimestamp createdAt={message.createdAt} />
      </div>
    </div>
  );
});

function formatMessageTimestamp(iso: string): {
  short: string;
  full: string;
} {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { short: "", full: "" };
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const sameYear = date.getFullYear() === now.getFullYear();
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  let short: string;
  if (sameDay) {
    short = time;
  } else if (sameYear) {
    short = `${date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })}, ${time}`;
  } else {
    short = `${date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    })}, ${time}`;
  }
  return { short, full: date.toLocaleString() };
}

function MessageTimestamp({ createdAt }: { createdAt: string }) {
  const { short, full } = formatMessageTimestamp(createdAt);
  if (!short) return null;
  return (
    <span
      className="text-[11px] text-muted-foreground/70 px-1 select-none"
      title={full}
    >
      {short}
    </span>
  );
}

const LiveBubble = memo(function LiveBubble({
  live,
  debugMode,
}: {
  live: LiveAssistant;
  debugMode: boolean;
}) {
  const label = live.content
    ? "Working…"
    : live.thinking || live.toolCalls.length > 0
      ? "Thinking…"
      : "Waiting for AI…";
  const hasSegments = live.segments.length > 0;
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-md px-4 py-3 bg-muted/50 text-foreground text-sm border border-border/60">
        {live.thinking && <ThinkingBlock text={live.thinking} defaultOpen />}
        {hasSegments && (
          <SegmentsRenderer
            segments={live.segments}
            toolLatencies={debugMode ? live.debug.toolLatencies : undefined}
          />
        )}
        <div
          className={`flex items-center gap-2 text-muted-foreground ${hasSegments ? "mt-2" : ""}`}
        >
          <span className="flex gap-1 items-center">
            <span className="size-1.5 rounded-full bg-current animate-pulse" />
            <span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
            <span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
          </span>
          <span className="text-xs italic">{label}</span>
        </div>
        {debugMode && <DebugPanel debug={live.debug} />}
      </div>
    </div>
  );
});

function DebugPanel({ debug }: { debug: DebugState }) {
  const [open, setOpen] = useState(true);
  const { events, meta } = debug;
  const totalEvents = events.length;
  return (
    <div
      dir="ltr"
      className="mt-3 border-t border-amber-500/30 pt-2 text-xs text-left"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="font-mono uppercase tracking-wide text-amber-400 hover:text-amber-300 flex items-center gap-1"
      >
        <span>{open ? "▾" : "▸"}</span>
        Debug {meta ? "(final)" : `(${totalEvents} events)`}
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {meta && <DebugMetaGrid meta={meta} />}
          {meta?.userPrompt && (
            <DebugTextBlock
              label="User prompt"
              text={meta.userPrompt}
              defaultOpen={false}
            />
          )}
          {meta?.systemAppend && (
            <DebugTextBlock
              label="System prompt (our append)"
              text={meta.systemAppend}
              note={meta.systemPresetNote}
              defaultOpen={false}
            />
          )}
          {events.length > 0 && <DebugEventLog events={events} />}
          {events.length === 0 && !meta && (
            <p className="text-muted-foreground font-mono">
              Waiting for SDK events…
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function DebugMetaGrid({ meta }: { meta: DebugMeta }) {
  const fmtMs = (v: number | undefined) =>
    v == null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
  const fmtTokens = (v: number | undefined) =>
    v == null ? "—" : v.toLocaleString();
  const rows: [string, string][] = [
    ["Model", meta.model ?? "—"],
    ["Turns", meta.numTurns != null ? String(meta.numTurns) : "—"],
    ["Duration", fmtMs(meta.durationMs)],
    ["API time", fmtMs(meta.durationApiMs)],
    ["Input tok", fmtTokens(meta.inputTokens)],
    ["Output tok", fmtTokens(meta.outputTokens)],
    ["Cache write", fmtTokens(meta.cacheCreationTokens)],
    ["Cache read", fmtTokens(meta.cacheReadTokens)],
    [
      "Cost",
      meta.totalCostUsd != null ? `$${meta.totalCostUsd.toFixed(4)}` : "—",
    ],
  ];
  const tools = Object.entries(meta.toolCallsByName).sort(
    (a, b) => b[1] - a[1]
  );
  return (
    <div className="space-y-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2">
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 font-mono">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-col">
            <span className="text-muted-foreground text-[10px] uppercase tracking-wide">
              {k}
            </span>
            <span className="text-amber-200">{v}</span>
          </div>
        ))}
      </div>
      {tools.length > 0 && (
        <div className="font-mono">
          <div className="text-muted-foreground text-[10px] uppercase tracking-wide mb-1">
            Tool calls
          </div>
          <div className="flex flex-wrap gap-1">
            {tools.map(([name, n]) => (
              <span
                key={name}
                className="px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-200"
              >
                {name} × {n}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DebugTextBlock({
  label,
  text,
  note,
  defaultOpen = false,
}: {
  label: string;
  text: string;
  note?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const chars = text.length;
  const approxTokens = Math.round(chars / 4);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Copy failed");
    }
  }
  return (
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="font-mono uppercase tracking-wide text-amber-400 hover:text-amber-300 flex items-center gap-1 text-[10px]"
        >
          <span>{open ? "▾" : "▸"}</span>
          {label}
        </button>
        <span className="text-[10px] text-muted-foreground font-mono">
          {chars.toLocaleString()} chars · ~{approxTokens.toLocaleString()} tokens
        </span>
        <button
          type="button"
          onClick={copy}
          className="ml-auto text-[10px] font-mono text-muted-foreground hover:text-amber-300"
        >
          Copy
        </button>
      </div>
      {open && (
        <>
          {note && (
            <p className="px-2 pb-1.5 text-[10px] italic text-muted-foreground font-mono">
              {note}
            </p>
          )}
          <pre className="px-2 pb-2 text-[11px] font-mono whitespace-pre-wrap text-amber-100/90 max-h-60 overflow-auto border-t border-amber-500/20 pt-2">
            {text}
          </pre>
        </>
      )}
    </div>
  );
}

function DebugEventLog({ events }: { events: DebugSdkEvent[] }) {
  // The first SDK event often lands several seconds after query() — that's
  // the model's warmup (system prompt processing + time-to-first-token).
  // We subtract that from `tFromFirst` so later rows aren't dominated by it.
  const firstEventMs = events[0]?.sinceStartMs ?? 0;

  const rowClass = (sdkType: string) => {
    if (sdkType === "assistant")
      return "bg-sky-500/[0.08] hover:bg-sky-500/15";
    if (sdkType === "user") return "bg-emerald-500/[0.08] hover:bg-emerald-500/15";
    if (sdkType === "result")
      return "bg-fuchsia-500/[0.1] hover:bg-fuchsia-500/15 font-semibold";
    return "odd:bg-white/[0.02] hover:bg-white/[0.05]";
  };
  const typeColor = (sdkType: string) => {
    if (sdkType === "assistant") return "text-sky-200";
    if (sdkType === "user") return "text-emerald-200";
    if (sdkType === "result") return "text-fuchsia-200";
    return "text-amber-200";
  };

  return (
    <div
      className="rounded-md border border-amber-500/20 bg-black/20 font-mono text-[11px] overflow-auto resize-y"
      style={{ height: 360 }}
    >
      <table className="w-full">
        <thead className="sticky top-0 bg-black/60 backdrop-blur text-muted-foreground text-[10px] uppercase">
          <tr>
            <th className="text-left px-2 py-1">+Δ prev</th>
            <th className="text-left px-2 py-1">t</th>
            <th className="text-left px-2 py-1">t (post-warmup)</th>
            <th className="text-left px-2 py-1">type</th>
            <th className="text-left px-2 py-1">summary</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => {
            const postWarmupMs = Math.max(0, e.sinceStartMs - firstEventMs);
            return (
              <tr key={i} className={rowClass(e.sdkType)}>
                <td className="px-2 py-0.5 text-amber-300/80">
                  +{e.sinceLastMs}ms
                </td>
                <td className="px-2 py-0.5 text-muted-foreground">
                  {(e.sinceStartMs / 1000).toFixed(1)}s
                </td>
                <td className="px-2 py-0.5 text-muted-foreground">
                  {i === 0 ? "—" : `${(postWarmupMs / 1000).toFixed(1)}s`}
                </td>
                <td className={`px-2 py-0.5 ${typeColor(e.sdkType)}`}>
                  {e.sdkType}
                  {e.sdkSubtype ? `.${e.sdkSubtype}` : ""}
                </td>
                <td className="px-2 py-0.5 text-muted-foreground truncate max-w-[260px]">
                  {e.summary ?? ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ThinkingBlock({
  text,
  defaultOpen = false,
}: {
  text: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-2 border-l-2 border-muted-foreground/30 pl-2 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="font-mono uppercase tracking-wide hover:text-foreground flex items-center gap-1"
      >
        <span>{open ? "▾" : "▸"}</span>
        Thinking
      </button>
      {open && (
        <div
          dir="auto"
          className="mt-1 whitespace-pre-wrap font-mono opacity-80 max-h-40 overflow-auto"
        >
          {text}
        </div>
      )}
    </div>
  );
}

function getField(obj: unknown, key: string): unknown {
  if (typeof obj === "object" && obj !== null && key in obj) {
    return (obj as Record<string, unknown>)[key];
  }
  return undefined;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function shortPath(p: string): string {
  // Trim to last ~3 segments so long absolute paths don't wrap the bubble.
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-3).join("/");
}

function trimCommonEdges(a: string, b: string): { a: string; b: string; prefixLines: number; suffixLines: number } {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  let pre = 0;
  while (pre < aLines.length && pre < bLines.length && aLines[pre] === bLines[pre]) pre++;
  let suf = 0;
  while (
    suf < aLines.length - pre &&
    suf < bLines.length - pre &&
    aLines[aLines.length - 1 - suf] === bLines[bLines.length - 1 - suf]
  ) {
    suf++;
  }
  return {
    a: aLines.slice(pre, aLines.length - suf).join("\n"),
    b: bLines.slice(pre, bLines.length - suf).join("\n"),
    prefixLines: pre,
    suffixLines: suf,
  };
}

function DiffBlock({ oldText, newText }: { oldText: string; newText: string }) {
  const { a, b, prefixLines, suffixLines } = trimCommonEdges(oldText, newText);
  const removed = a ? a.split("\n") : [];
  const added = b ? b.split("\n") : [];
  return (
    <div className="mt-1 rounded border border-border/50 bg-background/40 font-mono text-[11px] leading-relaxed overflow-x-auto">
      {(prefixLines > 0 || suffixLines > 0) && (
        <div className="px-2 py-0.5 text-muted-foreground/60 border-b border-border/40">
          @@ {prefixLines > 0 ? `${prefixLines} unchanged above` : ""}
          {prefixLines > 0 && suffixLines > 0 ? " · " : ""}
          {suffixLines > 0 ? `${suffixLines} unchanged below` : ""} @@
        </div>
      )}
      {removed.map((line, i) => (
        <div
          key={`r${i}`}
          className="px-2 whitespace-pre bg-red-500/10 text-red-300"
        >
          <span className="opacity-50 select-none">- </span>
          {line || " "}
        </div>
      ))}
      {added.map((line, i) => (
        <div
          key={`a${i}`}
          className="px-2 whitespace-pre bg-emerald-500/10 text-emerald-300"
        >
          <span className="opacity-50 select-none">+ </span>
          {line || " "}
        </div>
      ))}
    </div>
  );
}

function ToolCallCard({
  tc,
  durationMs,
}: {
  tc: { name: string; input: unknown };
  durationMs?: number;
}) {
  const name = tc.name;
  const input = tc.input;

  // --- Edit / MultiEdit -----------------------------------------------------
  if (name === "Edit") {
    const filePath = asString(getField(input, "file_path"));
    const oldStr = asString(getField(input, "old_string")) ?? "";
    const newStr = asString(getField(input, "new_string")) ?? "";
    return (
      <ToolCardShell label="Edit" target={filePath} durationMs={durationMs}>
        <DiffBlock oldText={oldStr} newText={newStr} />
      </ToolCardShell>
    );
  }
  if (name === "MultiEdit") {
    const filePath = asString(getField(input, "file_path"));
    const edits = getField(input, "edits");
    const list = Array.isArray(edits) ? edits : [];
    return (
      <ToolCardShell
        label={`MultiEdit (${list.length})`}
        target={filePath}
        durationMs={durationMs}
      >
        {list.map((e, i) => (
          <DiffBlock
            key={i}
            oldText={asString(getField(e, "old_string")) ?? ""}
            newText={asString(getField(e, "new_string")) ?? ""}
          />
        ))}
      </ToolCardShell>
    );
  }

  // --- Write ----------------------------------------------------------------
  if (name === "Write") {
    const filePath = asString(getField(input, "file_path"));
    const content = asString(getField(input, "content")) ?? "";
    const lines = content.split("\n");
    const preview = lines.slice(0, 12).join("\n");
    return (
      <ToolCardShell label="Write" target={filePath} durationMs={durationMs}>
        <div className="mt-1 rounded border border-border/50 bg-background/40 font-mono text-[11px] leading-relaxed overflow-x-auto">
          {preview.split("\n").map((line, i) => (
            <div
              key={i}
              className="px-2 whitespace-pre bg-emerald-500/10 text-emerald-300"
            >
              <span className="opacity-50 select-none">+ </span>
              {line || " "}
            </div>
          ))}
          {lines.length > 12 && (
            <div className="px-2 py-0.5 text-muted-foreground/60">
              … {lines.length - 12} more line{lines.length - 12 === 1 ? "" : "s"}
            </div>
          )}
        </div>
      </ToolCardShell>
    );
  }

  // --- Read -----------------------------------------------------------------
  if (name === "Read") {
    const filePath = asString(getField(input, "file_path"));
    const offset = getField(input, "offset");
    const limit = getField(input, "limit");
    let range: string | null = null;
    if (typeof offset === "number" && typeof limit === "number") {
      range = `lines ${offset}-${offset + limit - 1}`;
    } else if (typeof limit === "number") {
      range = `lines 1-${limit}`;
    }
    return (
      <ToolCardShell
        label="Read"
        target={filePath}
        suffix={range}
        durationMs={durationMs}
      />
    );
  }

  // --- Bash -----------------------------------------------------------------
  if (name === "Bash") {
    const cmd = asString(getField(input, "command")) ?? "";
    const desc = asString(getField(input, "description"));
    const firstLine = cmd.split("\n")[0] ?? "";
    return (
      <ToolCardShell
        label="Bash"
        target={desc ?? undefined}
        durationMs={durationMs}
      >
        <div className="mt-1 rounded border border-border/50 bg-background/40 px-2 py-1 font-mono text-[11px] text-foreground/80 whitespace-pre-wrap break-all">
          <span className="opacity-50 select-none">$ </span>
          {firstLine}
          {cmd.includes("\n") && <span className="opacity-50"> …</span>}
        </div>
      </ToolCardShell>
    );
  }

  // --- Grep / Glob ----------------------------------------------------------
  if (name === "Grep") {
    const pattern = asString(getField(input, "pattern")) ?? "";
    const path = asString(getField(input, "path"));
    return (
      <ToolCardShell
        label="Grep"
        target={pattern}
        suffix={path ? `in ${shortPath(path)}` : null}
        durationMs={durationMs}
      />
    );
  }
  if (name === "Glob") {
    const pattern = asString(getField(input, "pattern")) ?? "";
    return (
      <ToolCardShell label="Glob" target={pattern} durationMs={durationMs} />
    );
  }

  // --- Fallback -------------------------------------------------------------
  const filePath = asString(getField(input, "file_path"));
  return (
    <ToolCardShell label={name} target={filePath} durationMs={durationMs} />
  );
}

function ToolCardShell({
  label,
  target,
  suffix,
  durationMs,
  children,
}: {
  label: string;
  target?: string | null;
  suffix?: string | null;
  /** Wall-clock from `tool_use` to `tool_result`, in ms. Rendered as a badge after the suffix. Debug-mode only — caller decides when to pass it. */
  durationMs?: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="text-xs text-muted-foreground">
      <div className="flex items-center gap-1.5 font-mono">
        <Wrench className="size-3 shrink-0" />
        <span className="font-semibold text-foreground/80">{label}</span>
        {target && (
          <span className="opacity-80 truncate">
            {target.startsWith("/") ? shortPath(target) : target}
          </span>
        )}
        {suffix && <span className="opacity-60">({suffix})</span>}
        {typeof durationMs === "number" && (
          <span
            className="ml-auto shrink-0 rounded bg-amber-500/10 text-amber-400/90 px-1 py-px font-mono text-[10px] tabular-nums"
            title={`Tool execution: ${durationMs.toLocaleString()}ms`}
          >
            {formatToolDuration(durationMs)}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

const ToolCallsList = memo(function ToolCallsList({
  toolCalls,
  toolLatencies,
}: {
  toolCalls: { name: string; input: unknown; id?: string }[];
  /** Optional debug-only map from tool_use_id to wall-clock latency. When provided, each card shows a `(1.2s)` badge. */
  toolLatencies?: Record<string, ToolLatency>;
}) {
  return (
    <div className="mb-2 space-y-2">
      {toolCalls.map((tc, i) => (
        <ToolCallCard
          key={i}
          tc={tc}
          durationMs={
            tc.id && toolLatencies?.[tc.id]
              ? toolLatencies[tc.id].durationMs
              : undefined
          }
        />
      ))}
    </div>
  );
});

/**
 * Render an interleaved transcript of text + tool calls in the order the model
 * emitted them. Text is rendered as markdown; tool calls as their rich cards.
 */
const SegmentsRenderer = memo(function SegmentsRenderer({
  segments,
  toolLatencies,
}: {
  segments: MessageSegment[];
  /** Same shape as ToolCallsList — per-id latency map, debug-only. */
  toolLatencies?: Record<string, ToolLatency>;
}) {
  return (
    <div className="space-y-2">
      {segments.map((seg, i) =>
        seg.type === "text" ? (
          <div
            key={i}
            dir="auto"
            className="prose prose-sm prose-invert max-w-none"
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={MARKDOWN_COMPONENTS}
            >
              {seg.text}
            </ReactMarkdown>
          </div>
        ) : (
          <ToolCallCard
            key={i}
            tc={{ name: seg.name, input: seg.input }}
            durationMs={
              seg.id && toolLatencies?.[seg.id]
                ? toolLatencies[seg.id].durationMs
                : undefined
            }
          />
        )
      )}
    </div>
  );
});
