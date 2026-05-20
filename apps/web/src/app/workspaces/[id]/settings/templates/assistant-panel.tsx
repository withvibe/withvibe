"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Bot, Check, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TemplateEditorState } from "./template-editor";

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "pending" | "accepted" | "rejected" | "failed";
  error?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolCalls: ToolCall[];
  streaming?: boolean;
};

export type ApplyToolResult = { ok: boolean; error?: string };
export type ApplyToolCall = (
  name: string,
  input: Record<string, unknown>
) => ApplyToolResult;

type Props = {
  workspaceId: string;
  getState: () => TemplateEditorState;
  applyToolCall: ApplyToolCall;
  /**
   * "sheet" (default): collapsed by default, opens into a right-side overlay
   * with a body-padding shim so the page shifts behind it.
   * "inline": always visible, rendered in the parent flow with no fixed
   * positioning, no toggle button, no body-padding shim. Use when the panel
   * is part of an IDE-style three-pane layout.
   */
  variant?: "sheet" | "inline";
};

export type AssistantPanelHandle = {
  /** Open the panel and optionally prefill / auto-send a prompt. */
  openWith: (opts?: { prompt?: string; autoSend?: boolean }) => void;
};

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export const AssistantPanel = forwardRef<AssistantPanelHandle, Props>(function AssistantPanel(
  { workspaceId, getState, applyToolCall, variant = "sheet" },
  forwardedRef
) {
  // Inline mode is always visible — the sheet's open/close state is irrelevant
  // there. Default the controlled flag accordingly.
  const inline = variant === "inline";
  const [open, setOpen] = useState(inline);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingAutoSendRef = useRef<string | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-send any pending prompt once the sheet is open. We wait until the
  // sheet renders so the streaming UI is visible from the first token.
  useEffect(() => {
    if (open && pendingAutoSendRef.current) {
      const text = pendingAutoSendRef.current;
      pendingAutoSendRef.current = null;
      void send(text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useImperativeHandle(forwardedRef, () => ({
    openWith: (opts) => {
      if (opts?.prompt !== undefined) setInput(opts.prompt);
      if (opts?.autoSend && opts.prompt) {
        pendingAutoSendRef.current = opts.prompt;
      }
      setOpen(true);
    },
  }));

  // ⌘K / Ctrl+K toggles the panel. Inline mode skips this — the panel is
  // always visible and there's nothing to toggle.
  useEffect(() => {
    if (inline) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline]);

  // While the sheet is open, reserve space for it on the right so the
  // editor's centered layout shifts left instead of being overlapped.
  // Inline mode skips this — the parent already lays out a column for us.
  useEffect(() => {
    if (inline) return;
    const PANEL_WIDTH_PX = 512; // matches md:w-[32rem] below
    if (!open) return;
    const prev = document.body.style.paddingRight;
    document.body.style.paddingRight = `${PANEL_WIDTH_PX}px`;
    return () => {
      document.body.style.paddingRight = prev;
    };
  }, [open, inline]);

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  async function send(override?: string) {
    const text = (override ?? input).trim();
    if (!text || busy) return;
    setInput("");

    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      text,
      toolCalls: [],
    };
    const assistantMsg: ChatMessage = {
      id: uid(),
      role: "assistant",
      text: "",
      toolCalls: [],
      streaming: true,
    };
    const baseHistory = [...messages, userMsg];
    setMessages([...baseHistory, assistantMsg]);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/env-templates/assist`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            messages: baseHistory.map((m) => ({
              role: m.role,
              content: m.text,
            })),
            templateState: getState(),
          }),
        }
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(
          (j as { message?: string }).message ||
            `Request failed with ${res.status}`
        );
      }
      if (!res.body) throw new Error("No response body");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const ev of events) {
          const line = ev.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(json);
          } catch {
            continue;
          }
          handleEvent(assistantMsg.id, parsed as Record<string, unknown>);
        }
      }
      finalizeStreamingMessage(assistantMsg.id);
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        finalizeStreamingMessage(assistantMsg.id);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(msg);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, text: m.text + `\n\n[error: ${msg}]`, streaming: false }
              : m
          )
        );
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function handleEvent(messageId: string, ev: Record<string, unknown>) {
    if (ev.type === "text_delta" && typeof ev.text === "string") {
      const text = ev.text;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, text: m.text + text } : m
        )
      );
    } else if (ev.type === "info") {
      // No-op — server emits a credential-source hint we used during debugging.
    } else if (ev.type === "tool_use") {
      const id = String(ev.id ?? uid());
      const name = String(ev.name ?? "");
      const input = (ev.input ?? {}) as Record<string, unknown>;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                toolCalls: [
                  ...m.toolCalls,
                  { id, name, input, status: "pending" },
                ],
              }
            : m
        )
      );
    } else if (ev.type === "error" && typeof ev.message === "string") {
      const msg = ev.message;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, text: m.text + `\n\n[error: ${msg}]` }
            : m
        )
      );
      toast.error(msg);
    }
  }

  function finalizeStreamingMessage(messageId: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === messageId ? { ...m, streaming: false } : m))
    );
  }

  function decideOnTool(
    messageId: string,
    toolId: string,
    decision: "accept" | "reject"
  ) {
    // Find the pending tool call up-front so the side-effect (apply to
    // parent state) happens *outside* the setMessages updater. Calling a
    // parent setState from inside an updater function violates React's
    // "no setState during render" rule (StrictMode reruns updaters during
    // render, which would re-fire applyToolCall mid-render).
    const message = messages.find((m) => m.id === messageId);
    const tool = message?.toolCalls.find((t) => t.id === toolId);
    if (!tool || tool.status !== "pending") return;

    let nextStatus: ToolCall["status"];
    let nextError: string | undefined;
    if (decision === "reject") {
      nextStatus = "rejected";
    } else {
      const res = applyToolCall(tool.name, tool.input);
      if (res.ok) {
        nextStatus = "accepted";
      } else {
        nextStatus = "failed";
        nextError = res.error;
        toast.error(res.error || "Tool call failed");
      }
    }

    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              toolCalls: m.toolCalls.map((t) =>
                t.id === toolId
                  ? { ...t, status: nextStatus, error: nextError }
                  : t
              ),
            }
          : m
      )
    );
  }

  function clearChat() {
    if (busy) stop();
    setMessages([]);
  }

  return (
    <>
      {!inline && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          title="DevOps (⌘K)"
          onClick={() => setOpen((o) => !o)}
        >
          <Sparkles className="size-4" /> DevOps
          <kbd className="ml-1 hidden md:inline-block text-[10px] font-mono text-muted-foreground border rounded px-1">
            ⌘K
          </kbd>
        </Button>
      )}

      {/* Sheet variant: non-modal right-side overlay with body-padding shim.
          Inline variant: drop the fixed-positioning + width classes, let the
          parent IDE layout size and position the column. */}
      <div
        aria-hidden={!inline && !open}
        className={cn(
          "flex flex-col bg-popover text-popover-foreground",
          inline
            ? "h-full w-full"
            : cn(
                "fixed inset-y-0 right-0 z-40 w-full sm:w-[28rem] md:w-[32rem] border-l shadow-xl transition-transform duration-200 ease-out",
                open ? "translate-x-0" : "translate-x-full pointer-events-none"
              )
        )}
      >
        <div className="border-b px-4 py-3 flex items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-base font-medium">
              <Bot className="size-4" /> DevOps
            </div>
            <div className="text-xs text-muted-foreground">
              The same agent that materializes envs from this template. Ask it
              to design the stack — proposed edits show as cards you accept or
              reject.
            </div>
          </div>
          {!inline && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setOpen(false)}
              title="Close (⌘K)"
            >
              <X className="size-4" />
            </Button>
          )}
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 ? (
            <div className="text-xs text-muted-foreground space-y-2">
              <p>Some things you can ask:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>&quot;Add a postgres service with a persistent volume&quot;</li>
                <li>&quot;What kind should APP_PORT be?&quot;</li>
                <li>&quot;Generate an nginx reverse proxy config asset&quot;</li>
                <li>&quot;Mark the web service as user-facing&quot;</li>
              </ul>
            </div>
          ) : (
            messages.map((m) => (
              <MessageView
                key={m.id}
                message={m}
                onDecide={(toolId, decision) =>
                  decideOnTool(m.id, toolId, decision)
                }
              />
            ))
          )}
        </div>

        <div className="border-t p-3 space-y-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter inserts a newline. Skip during IME
              // composition (e.g. Japanese/Korean input) so the Enter that
              // commits a candidate doesn't also send the message.
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
            rows={3}
            placeholder="Ask DevOps…  (Enter to send, Shift+Enter for newline)"
            className="text-sm h-20 resize-none [field-sizing:fixed]"
            disabled={busy}
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clearChat}
              disabled={busy && messages.length === 0}
            >
              Clear
            </Button>
            <div className="flex items-center gap-2">
              {busy && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={stop}
                >
                  Stop
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={() => void send()}
                disabled={busy || !input.trim()}
              >
                <Send className="size-4" /> Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
});

function MessageView({
  message,
  onDecide,
}: {
  message: ChatMessage;
  onDecide: (toolId: string, decision: "accept" | "reject") => void;
}) {
  const isUser = message.role === "user";
  return (
    <div
      className={cn(
        "rounded-md p-3 text-sm",
        isUser ? "bg-muted/50" : "bg-background border"
      )}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
        {isUser ? "You" : "Assistant"}
      </div>
      {message.text && (
        <div className="whitespace-pre-wrap break-words text-sm">
          {message.text}
          {message.streaming && <span className="animate-pulse">▍</span>}
        </div>
      )}
      {message.toolCalls.length > 0 && (
        <div className="mt-3 space-y-2">
          {message.toolCalls.map((t) => (
            <ToolCallCard
              key={t.id}
              toolCall={t}
              onAccept={() => onDecide(t.id, "accept")}
              onReject={() => onDecide(t.id, "reject")}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCallCard({
  toolCall,
  onAccept,
  onReject,
}: {
  toolCall: ToolCall;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <code className="font-mono text-xs font-semibold">{toolCall.name}</code>
        <ToolStatus status={toolCall.status} />
      </div>
      <ToolInputPreview name={toolCall.name} input={toolCall.input} />
      {toolCall.error && (
        <div className="text-xs text-destructive">{toolCall.error}</div>
      )}
      {toolCall.status === "pending" && (
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onReject}
          >
            <X className="size-3" /> Reject
          </Button>
          <Button type="button" size="sm" onClick={onAccept}>
            <Check className="size-3" /> Accept
          </Button>
        </div>
      )}
    </div>
  );
}

function ToolStatus({ status }: { status: ToolCall["status"] }) {
  const map: Record<ToolCall["status"], { label: string; cls: string }> = {
    pending: {
      label: "Pending",
      cls: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400",
    },
    accepted: {
      label: "Accepted",
      cls: "bg-green-500/15 text-green-700 dark:text-green-400",
    },
    rejected: { label: "Rejected", cls: "bg-muted text-muted-foreground" },
    failed: {
      label: "Failed",
      cls: "bg-destructive/15 text-destructive",
    },
  };
  const { label, cls } = map[status];
  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", cls)}>
      {label}
    </span>
  );
}

function truncate(s: string, n = 280) {
  return s.length > n ? s.slice(0, n) + `… (${s.length - n} more chars)` : s;
}

function ToolInputPreview({
  name,
  input,
}: {
  name: string;
  input: Record<string, unknown>;
}) {
  // Custom previews for the most common tool calls so users can read the
  // diff without unfolding raw JSON.
  if (name === "patchComposeFile") {
    const oldStr = String(input.oldString ?? "");
    const newStr = String(input.newString ?? "");
    return (
      <div className="space-y-1 text-xs">
        <div className="bg-red-500/10 border border-red-500/30 rounded px-2 py-1 font-mono whitespace-pre-wrap break-words">
          {truncate(oldStr)}
        </div>
        <div className="bg-green-500/10 border border-green-500/30 rounded px-2 py-1 font-mono whitespace-pre-wrap break-words">
          {truncate(newStr)}
        </div>
      </div>
    );
  }
  if (name === "setComposeFile" || name === "setAgentInstructions") {
    const content = String(input.content ?? "");
    return (
      <pre className="bg-background border rounded px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto">
        {truncate(content, 1200)}
      </pre>
    );
  }
  if (name === "writeAsset") {
    const path = String(input.path ?? "");
    const content = String(input.content ?? "");
    const isTemplate = !!input.isTemplate;
    return (
      <div className="space-y-1 text-xs">
        <div>
          <code className="font-mono">{path}</code>
          {isTemplate && (
            <span className="ml-2 text-muted-foreground">[interpolated]</span>
          )}
        </div>
        <pre className="bg-background border rounded px-2 py-1 font-mono whitespace-pre-wrap break-words max-h-48 overflow-auto">
          {truncate(content, 800)}
        </pre>
      </div>
    );
  }
  // Fallback — render JSON.
  return (
    <pre className="bg-background border rounded px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words max-h-48 overflow-auto">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}
