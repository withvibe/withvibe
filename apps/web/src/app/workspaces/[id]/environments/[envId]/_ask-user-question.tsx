"use client";

import { useState } from "react";
import { Check, CircleHelp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type AskQuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AskQuestion = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AskQuestionOption[];
};

/**
 * The card for an in-flight `AskUserQuestion`. The agent's turn is parked
 * server-side until this posts an answer, so the pending state is a real
 * "everything is waiting on you" — not a passive prompt.
 *
 * `status` is driven by the stream, not by this component: the turn can be
 * closed out from under it (timeout, interrupt, another tab answering), and
 * when that happens the card must stop accepting input.
 */
export function AskUserQuestionCard({
  toolUseId,
  questions,
  status,
  workspaceId,
  envId,
  onAnswered,
}: {
  toolUseId: string;
  questions: AskQuestion[];
  status: "pending" | "answered" | "closed";
  workspaceId: string;
  envId: string;
  onAnswered?: () => void;
}) {
  // question text → chosen label(s). Multi-select joins with ", " on submit,
  // which is what the tool's flat `answers: Record<string,string>` expects.
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const disabled = status !== "pending" || submitting;

  function toggle(q: AskQuestion, label: string) {
    if (disabled) return;
    setPicked((prev) => {
      const current = prev[q.question] ?? [];
      if (!q.multiSelect) return { ...prev, [q.question]: [label] };
      return {
        ...prev,
        [q.question]: current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label],
      };
    });
  }

  function answerFor(q: AskQuestion): string {
    const free = other[q.question]?.trim();
    const chosen = picked[q.question] ?? [];
    if (chosen.length === 0) return free ?? "";
    return free ? [...chosen, free].join(", ") : chosen.join(", ");
  }

  const complete = questions.every((q) => answerFor(q).length > 0);

  async function submit() {
    if (disabled || !complete) return;
    setSubmitting(true);
    setError("");
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = answerFor(q);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/questions/${toolUseId}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        }
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.message || "Could not send your answer.");
        setSubmitting(false);
        return;
      }
      onAnswered?.();
    } catch {
      setError("Could not reach the server.");
      setSubmitting(false);
    }
  }

  async function skip() {
    if (disabled) return;
    setSubmitting(true);
    await fetch(
      `/api/workspaces/${workspaceId}/envs/${envId}/questions/${toolUseId}/skip`,
      { method: "POST" }
    ).catch(() => {});
    onAnswered?.();
  }

  return (
    <div
      className={cn(
        "rounded-md border p-3 space-y-3",
        status === "pending" ? "border-primary/50 bg-primary/5" : "opacity-70"
      )}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CircleHelp className="size-4" />
        {status === "pending" ? (
          <span>The agent is waiting on your answer</span>
        ) : status === "answered" ? (
          <span className="flex items-center gap-1">
            <Check className="size-3" /> Answered
          </span>
        ) : (
          <span>No longer waiting</span>
        )}
      </div>

      {questions.map((q) => {
        const chosen = picked[q.question] ?? [];
        return (
          <div key={q.question} className="space-y-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              {q.header && (
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide">
                  {q.header}
                </span>
              )}
              <p className="text-sm font-medium" dir="auto">
                {q.question}
              </p>
            </div>

            <div className="grid gap-1.5">
              {q.options.map((o) => {
                const on = chosen.includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    disabled={disabled}
                    onClick={() => toggle(q, o.label)}
                    dir="auto"
                    className={cn(
                      "rounded border p-2 text-left transition-colors",
                      on
                        ? "border-primary bg-primary/10"
                        : "hover:bg-muted/50",
                      disabled && "cursor-default"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-3 shrink-0 border",
                          q.multiSelect ? "rounded-[3px]" : "rounded-full",
                          on && "bg-primary border-primary"
                        )}
                      />
                      <span className="text-sm">{o.label}</span>
                    </div>
                    {o.description && (
                      <p className="mt-0.5 pl-5 text-xs text-muted-foreground">
                        {o.description}
                      </p>
                    )}
                    {o.preview && (
                      <pre className="mt-1 ml-5 max-h-40 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] whitespace-pre">
                        {o.preview}
                      </pre>
                    )}
                  </button>
                );
              })}
            </div>

            {/* The tool description promises an "Other" escape hatch and tells
                the model not to author one, so the UI has to supply it. */}
            <Input
              value={other[q.question] ?? ""}
              disabled={disabled}
              dir="auto"
              placeholder="Other — type your own answer"
              className="h-8 text-xs"
              onChange={(e) =>
                setOther((prev) => ({ ...prev, [q.question]: e.target.value }))
              }
            />
          </div>
        );
      })}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {status === "pending" && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={disabled || !complete}
            onClick={submit}
          >
            {submitting && <Loader2 className="size-3 animate-spin" />}
            Send answer
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={skip}
          >
            Skip
          </Button>
        </div>
      )}
    </div>
  );
}
