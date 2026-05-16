"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  ScanLine,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The Security scan experience. A button kicks off the built-in Security
 * agent (behind the scenes it's a chat turn with a structured kickoff
 * prompt — see apps/api .../security-scan.service.ts), but the user sees a
 * progress bar + a diagnostic report instead of a raw chat transcript.
 *
 * Two machine-readable contracts come back over the agent's text stream:
 *  - `::SCAN_PHASE:: <id>` lines drive the phase stepper.
 *  - a trailing ```scan-result JSON block renders the diagnostic.
 */

type Severity = "critical" | "high" | "medium" | "low";

type Finding = {
  severity: Severity;
  title: string;
  repo: string;
  file: string;
  line: number;
  detail: string;
  recommendation: string;
};

type ScanResult = {
  verdict: "pass" | "warn" | "fail";
  summary: string;
  counts: Record<Severity, number>;
  findings: Finding[];
};

type Phase = { id: string; label: string };

const PHASES: Phase[] = [
  { id: "collect", label: "Collecting changes" },
  { id: "secrets", label: "Scanning for secrets" },
  { id: "deps", label: "Dependencies & config" },
  { id: "code", label: "Reviewing code" },
  { id: "report", label: "Compiling report" },
];

type Status = "idle" | "starting" | "running" | "done" | "error";

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

const SEVERITY_STYLE: Record<
  Severity,
  { dot: string; text: string; chip: string; border: string }
> = {
  critical: {
    dot: "bg-red-500",
    text: "text-red-400",
    chip: "bg-red-500/10 text-red-400 border-red-500/20",
    border: "border-l-red-500",
  },
  high: {
    dot: "bg-orange-500",
    text: "text-orange-400",
    chip: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    border: "border-l-orange-500",
  },
  medium: {
    dot: "bg-yellow-500",
    text: "text-yellow-400",
    chip: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    border: "border-l-yellow-500",
  },
  low: {
    dot: "bg-sky-500",
    text: "text-sky-400",
    chip: "bg-sky-500/10 text-sky-400 border-sky-500/20",
    border: "border-l-sky-500",
  },
};

/** Extract the last ```scan-result fenced JSON block, tolerant of stray commas. */
function parseScanResult(text: string): ScanResult | null {
  const blocks = [...text.matchAll(/```scan-result\s*([\s\S]*?)```/g)];
  let raw = blocks.length ? blocks[blocks.length - 1][1].trim() : null;
  if (!raw) {
    // Fallback: a bare JSON object with the telltale "verdict" key.
    const m = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
    raw = m ? m[0] : null;
  }
  if (!raw) return null;
  for (const candidate of [raw, raw.replace(/,\s*([}\]])/g, "$1")]) {
    try {
      const obj = JSON.parse(candidate) as Partial<ScanResult>;
      const counts = obj.counts ?? {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      };
      const findings = Array.isArray(obj.findings) ? obj.findings : [];
      return {
        verdict:
          obj.verdict === "fail" || obj.verdict === "warn"
            ? obj.verdict
            : obj.verdict === "pass"
              ? "pass"
              : findings.some(
                    (f) => f.severity === "critical" || f.severity === "high"
                  )
                ? "fail"
                : findings.length
                  ? "warn"
                  : "pass",
        summary: typeof obj.summary === "string" ? obj.summary : "",
        counts: {
          critical: Number(counts.critical) || 0,
          high: Number(counts.high) || 0,
          medium: Number(counts.medium) || 0,
          low: Number(counts.low) || 0,
        },
        findings: findings.map((f) => ({
          severity: SEVERITY_ORDER.includes(f.severity as Severity)
            ? (f.severity as Severity)
            : "low",
          title: String(f.title ?? "Untitled finding"),
          repo: String(f.repo ?? ""),
          file: String(f.file ?? ""),
          line: Number(f.line) || 0,
          detail: String(f.detail ?? ""),
          recommendation: String(f.recommendation ?? ""),
        })),
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Strip the protocol scaffolding so the raw analysis reads cleanly. */
function cleanNarrative(text: string): string {
  return text
    .replace(/```scan-result[\s\S]*?```/g, "")
    .replace(/^.*::SCAN_PHASE::.*$/gm, "")
    .trim();
}

/** Highest phase index mentioned so far, or -1. */
function phaseIndexFromText(text: string): number {
  let idx = -1;
  for (const m of text.matchAll(/::SCAN_PHASE::\s*([a-z]+)/gi)) {
    const i = PHASES.findIndex((p) => p.id === m[1].toLowerCase());
    if (i > idx) idx = i;
  }
  return idx;
}

/** Short human label for a tool_use event, for the live activity line. */
function describeTool(name: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "Bash": {
      const cmd = str(inp.command).replace(/\s+/g, " ").trim();
      return cmd ? `$ ${cmd.slice(0, 80)}` : "Running a command";
    }
    case "Read":
      return `Reading ${str(inp.file_path) || "a file"}`;
    case "Grep":
      return `Searching for ${JSON.stringify(str(inp.pattern)).slice(0, 60)}`;
    case "Glob":
      return `Listing ${str(inp.pattern) || "files"}`;
    default:
      return name;
  }
}

export function SecurityPanel({
  workspaceId,
  envId,
  scanRequest,
  onScanHandled,
}: {
  workspaceId: string;
  envId: string;
  /** A one-shot timestamp set by the parent when a button asks for a fresh
   *  scan. Cleared via {@link onScanHandled} so reopening the panel later
   *  (via the activity icon) doesn't re-trigger a stale request. */
  scanRequest?: number | null;
  onScanHandled?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [phaseIdx, setPhaseIdx] = useState(-1);
  const [activity, setActivity] = useState<string[]>([]);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [narrative, setNarrative] = useState("");
  const [showNarrative, setShowNarrative] = useState(false);
  const [ranAt, setRanAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const liveTextRef = useRef("");
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const loadLatestReport = useCallback(
    async (sessionId: string) => {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/messages?sessionId=${encodeURIComponent(
          sessionId
        )}`
      );
      if (!res.ok) return;
      const msgs = (await res.json()) as {
        role: string;
        content: string;
        createdAt: string;
      }[];
      const lastAssistant = [...msgs]
        .reverse()
        .find((m) => m.role === "assistant" && m.content.trim());
      if (!lastAssistant) return;
      const parsed = parseScanResult(lastAssistant.content);
      if (parsed) {
        setResult(parsed);
        setNarrative(cleanNarrative(lastAssistant.content));
        setRanAt(lastAssistant.createdAt);
        setStatus("done");
        setPhaseIdx(PHASES.length);
      }
    },
    [workspaceId, envId]
  );

  const consumeStream = useCallback(
    async (sessionId: string) => {
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      liveTextRef.current = "";
      let res: Response;
      try {
        res = await fetch(
          `/api/workspaces/${workspaceId}/envs/${envId}/messages/active-run/stream?sessionId=${encodeURIComponent(
            sessionId
          )}`,
          { signal: controller.signal }
        );
      } catch {
        if (mountedRef.current) {
          setStatus("error");
          setError("Couldn't connect to the scan stream.");
        }
        return;
      }
      if (!res.ok || !res.body) {
        if (mountedRef.current) {
          setStatus("error");
          setError("The scan stream is unavailable.");
        }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let ended = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() || "";
          for (const raw of frames) {
            if (!raw.startsWith("data:")) continue;
            const json = raw.slice(5).trim();
            if (!json) continue;
            let ev: {
              type: string;
              delta?: string;
              name?: string;
              input?: unknown;
              status?: string;
            };
            try {
              ev = JSON.parse(json);
            } catch {
              continue;
            }
            if (ev.type === "text" && typeof ev.delta === "string") {
              liveTextRef.current += ev.delta;
              const idx = phaseIndexFromText(liveTextRef.current);
              if (mountedRef.current) {
                setPhaseIdx((prev) => (idx > prev ? idx : prev));
              }
            } else if (ev.type === "thinking") {
              if (mountedRef.current)
                setActivity((a) => trimActivity(a, "Analyzing…"));
            } else if (ev.type === "tool_use" && ev.name) {
              const line = describeTool(ev.name, ev.input);
              if (mountedRef.current)
                setActivity((a) => trimActivity(a, line));
            } else if (ev.type === "session_idle") {
              ended = true;
            }
          }
          if (ended) break;
        }
      } catch (err) {
        if (
          !controller.signal.aborted &&
          (err as { name?: string })?.name !== "AbortError"
        ) {
          if (mountedRef.current) {
            setStatus("error");
            setError("The scan stream was interrupted.");
          }
          return;
        }
      }

      if (!mountedRef.current) return;
      // Stream finished — pull the persisted final message and parse it.
      const parsed = parseScanResult(liveTextRef.current);
      if (parsed) {
        setResult(parsed);
        setNarrative(cleanNarrative(liveTextRef.current));
        setRanAt(new Date().toISOString());
        setPhaseIdx(PHASES.length);
        setStatus("done");
      } else {
        await loadLatestReport(sessionId);
        setStatus((s) => (s === "running" ? "error" : s));
        setError((e) =>
          e ?? "The scan finished but produced no parseable result."
        );
      }
    },
    [workspaceId, envId, loadLatestReport]
  );

  const startScan = useCallback(async () => {
    setStatus("starting");
    setError(null);
    setResult(null);
    setNarrative("");
    setActivity([]);
    setPhaseIdx(-1);
    liveTextRef.current = "";
    let res: Response;
    try {
      res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/security-scan`,
        { method: "POST" }
      );
    } catch {
      setStatus("error");
      setError("Couldn't reach the server to start the scan.");
      return;
    }
    if (!res.ok) {
      setStatus("error");
      setError("Failed to start the security scan.");
      return;
    }
    const { sessionId } = (await res.json()) as { sessionId: string };
    sessionIdRef.current = sessionId;
    setStatus("running");
    void consumeStream(sessionId);
  }, [workspaceId, envId, consumeStream]);

  // On mount: load any prior report and reattach to a running scan.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/security-scan`
      );
      if (!res.ok || cancelled) return;
      const { sessionId } = (await res.json()) as {
        sessionId: string | null;
      };
      if (!sessionId || cancelled) return;
      sessionIdRef.current = sessionId;
      await loadLatestReport(sessionId);
      if (cancelled) return;
      const ar = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/messages/active-run?sessionId=${encodeURIComponent(
          sessionId
        )}`
      );
      if (!ar.ok || cancelled) return;
      const { status: runStatus } = (await ar.json()) as { status: string };
      if (runStatus === "running" && !cancelled) {
        setStatus("running");
        setResult(null);
        void consumeStream(sessionId);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, envId, loadLatestReport, consumeStream]);

  // A button asked for a scan. Consume the request immediately (clear it in
  // the parent) so reopening the panel later doesn't replay a stale one.
  useEffect(() => {
    if (scanRequest == null) return;
    onScanHandled?.();
    if (status === "running" || status === "starting") return;
    void startScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanRequest]);

  const busy = status === "running" || status === "starting";

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/60 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <ScanLine className="size-4 text-primary shrink-0" />
          <span className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground truncate">
            Security scan
          </span>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px]"
          onClick={startScan}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
          {status === "done" || result ? "Re-run scan" : "Run security review"}
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        {status === "idle" && !result && (
          <div className="text-center py-10 px-4 space-y-3">
            <ScanLine className="size-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-foreground/80">
              Run the Security agent against this env&apos;s code changes.
            </p>
            <p className="text-xs text-muted-foreground">
              It reviews everything changed vs. the base branch across all
              repos — injection, auth gaps, leaked secrets, and more.
            </p>
            <Button size="sm" onClick={startScan} className="mt-1">
              <ScanLine className="size-4" />
              Run security review
            </Button>
          </div>
        )}

        {busy && (
          <ScanProgress phaseIdx={phaseIdx} activity={activity} />
        )}

        {status === "error" && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive flex items-start gap-2">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium">Scan failed</div>
              <div className="text-destructive/80 mt-0.5">{error}</div>
            </div>
          </div>
        )}

        {result && !busy && (
          <ScanReport
            result={result}
            ranAt={ranAt}
            narrative={narrative}
            showNarrative={showNarrative}
            onToggleNarrative={() => setShowNarrative((v) => !v)}
          />
        )}
      </div>
    </div>
  );
}

function trimActivity(prev: string[], line: string): string[] {
  if (prev[prev.length - 1] === line) return prev;
  return [...prev, line].slice(-6);
}

function ScanProgress({
  phaseIdx,
  activity,
}: {
  phaseIdx: number;
  activity: string[];
}) {
  const pct =
    phaseIdx < 0
      ? 6
      : Math.min(100, Math.round(((phaseIdx + 1) / PHASES.length) * 100));
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin text-primary" />
          <span className="font-medium">Security agent is scanning…</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full bg-primary transition-all duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <ol className="space-y-1.5">
        {PHASES.map((p, i) => {
          const done = i < phaseIdx || (phaseIdx === PHASES.length && true);
          const current = i === phaseIdx;
          return (
            <li
              key={p.id}
              className={cn(
                "flex items-center gap-2 text-xs font-mono",
                done
                  ? "text-emerald-400"
                  : current
                    ? "text-foreground"
                    : "text-muted-foreground/50"
              )}
            >
              <span className="inline-flex size-4 items-center justify-center shrink-0">
                {done ? (
                  <Check className="size-3.5" />
                ) : current ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <span className="size-1.5 rounded-full bg-current opacity-50" />
                )}
              </span>
              {p.label}
            </li>
          );
        })}
      </ol>

      {activity.length > 0 && (
        <div className="rounded-md border border-border/60 bg-muted/20 p-2 space-y-1 max-h-32 overflow-auto">
          {activity.map((a, i) => (
            <div
              key={i}
              className={cn(
                "text-[10.5px] font-mono truncate",
                i === activity.length - 1
                  ? "text-foreground/80"
                  : "text-muted-foreground/60"
              )}
            >
              {a}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const VERDICT: Record<
  ScanResult["verdict"],
  { label: string; icon: typeof ShieldCheck; className: string }
> = {
  pass: {
    label: "No security issues found",
    icon: ShieldCheck,
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  },
  warn: {
    label: "Minor issues found",
    icon: ShieldAlert,
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  },
  fail: {
    label: "Security issues found",
    icon: ShieldX,
    className: "bg-red-500/10 text-red-400 border-red-500/20",
  },
};

function ScanReport({
  result,
  ranAt,
  narrative,
  showNarrative,
  onToggleNarrative,
}: {
  result: ScanResult;
  ranAt: string | null;
  narrative: string;
  showNarrative: boolean;
  onToggleNarrative: () => void;
}) {
  const v = VERDICT[result.verdict];
  const VIcon = v.icon;
  const sortedFindings = [...result.findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );
  return (
    <div className="space-y-3">
      <div className={cn("rounded-md border p-3 space-y-2", v.className)}>
        <div className="flex items-center gap-2">
          <VIcon className="size-5 shrink-0" />
          <span className="font-semibold text-sm">{v.label}</span>
        </div>
        {result.summary && (
          <p className="text-xs text-foreground/80 leading-relaxed">
            {result.summary}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {SEVERITY_ORDER.map((s) => (
            <span
              key={s}
              className={cn(
                "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono capitalize",
                result.counts[s] > 0
                  ? SEVERITY_STYLE[s].chip
                  : "bg-muted/40 text-muted-foreground/50 border-border/50"
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  result.counts[s] > 0
                    ? SEVERITY_STYLE[s].dot
                    : "bg-muted-foreground/30"
                )}
              />
              {result.counts[s]} {s}
            </span>
          ))}
        </div>
        {ranAt && (
          <p className="text-[10px] text-muted-foreground/70 font-mono">
            Scanned {new Date(ranAt).toLocaleString()}
          </p>
        )}
      </div>

      {sortedFindings.length === 0 ? (
        <div className="text-center py-6 text-xs text-muted-foreground">
          The changed code is clean. Nothing to fix.
        </div>
      ) : (
        <div className="space-y-2">
          {sortedFindings.map((f, i) => (
            <FindingCard key={i} finding={f} />
          ))}
        </div>
      )}

      {narrative && (
        <div className="border-t border-border/60 pt-2">
          <button
            type="button"
            onClick={onToggleNarrative}
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {showNarrative ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            Full agent analysis
          </button>
          {showNarrative && (
            <div className="prose prose-sm prose-invert max-w-none mt-2 text-xs">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {narrative}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const [open, setOpen] = useState(true);
  const st = SEVERITY_STYLE[finding.severity];
  const loc = [finding.repo, finding.file].filter(Boolean).join("/");
  return (
    <div
      className={cn(
        "rounded-md border bg-card border-l-2 overflow-hidden",
        st.border
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-muted/30"
      >
        <span
          className={cn(
            "mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono uppercase shrink-0",
            st.chip
          )}
        >
          {finding.severity}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-xs font-medium text-foreground">
            {finding.title}
          </span>
          {loc && (
            <span className="block text-[10.5px] font-mono text-muted-foreground truncate">
              {loc}
              {finding.line > 0 ? `:${finding.line}` : ""}
            </span>
          )}
        </span>
        {open ? (
          <ChevronDown className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronRight className="size-3.5 text-muted-foreground shrink-0 mt-0.5" />
        )}
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 pt-0 space-y-2 text-xs">
          {finding.detail && (
            <p className="text-foreground/80 leading-relaxed">
              {finding.detail}
            </p>
          )}
          {finding.recommendation && (
            <div className="rounded bg-muted/40 border border-border/50 p-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                Recommendation
              </div>
              <p className="text-foreground/80 leading-relaxed">
                {finding.recommendation}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
