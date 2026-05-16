"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Bot, Check, Inbox as InboxIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type InboxItem = {
  id: string;
  question: string;
  answer: string | null;
  status: "pending" | "answered" | "dismissed";
  createdAt: string;
  answeredAt: string | null;
  agent: { id: string; name: string; slug: string; kind: string } | null;
  askerUser: { id: string; name: string | null; email: string } | null;
  session: { id: string; title: string | null } | null;
  env: { id: string; title: string } | null;
};

export default function InboxPage(
  props: PageProps<"/workspaces/[id]/inbox">
) {
  const { id } = use(props.params);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${id}/inbox`);
    if (res.ok) setItems(await res.json());
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function answer(item: InboxItem) {
    const text = (drafts[item.id] || "").trim();
    if (!text) return;
    setBusy(item.id);
    const res = await fetch(
      `/api/workspaces/${id}/inbox/${item.id}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: text }),
      }
    );
    setBusy(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast.error(d.message || d.error || "Couldn't submit answer");
      return;
    }
    toast.success("Answer sent — the agent will see it next turn");
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    await load();
  }

  async function dismiss(item: InboxItem) {
    if (!confirm("Dismiss this question?")) return;
    setBusy(item.id);
    const res = await fetch(
      `/api/workspaces/${id}/inbox/${item.id}/dismiss`,
      { method: "POST" }
    );
    setBusy(null);
    if (!res.ok) {
      toast.error("Couldn't dismiss");
      return;
    }
    await load();
  }

  const pending = (items || []).filter((i) => i.status === "pending");
  const closed = (items || []).filter((i) => i.status !== "pending");

  return (
    <div className="max-w-4xl mx-auto p-6 sm:p-8 space-y-6">
      <div>
        <h1 className="text-xl font-mono font-bold tracking-tight flex items-center gap-2">
          <InboxIcon className="size-5" />
          Inbox
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Questions from agents that needed your input. Your answer is saved as
          memory so the agent picks it up on its next turn.
        </p>
      </div>

      {items === null ? (
        <Skeleton className="h-40 rounded-md" />
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Nothing here — agents haven&apos;t asked you anything yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {pending.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                Pending ({pending.length})
              </h2>
              <ul className="space-y-3">
                {pending.map((q) => (
                  <InboxCard
                    key={q.id}
                    item={q}
                    draft={drafts[q.id] || ""}
                    onDraftChange={(v) =>
                      setDrafts((prev) => ({ ...prev, [q.id]: v }))
                    }
                    busy={busy === q.id}
                    onAnswer={() => answer(q)}
                    onDismiss={() => dismiss(q)}
                  />
                ))}
              </ul>
            </section>
          )}

          {closed.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
                Closed
              </h2>
              <ul className="space-y-3">
                {closed.map((q) => (
                  <InboxCard
                    key={q.id}
                    item={q}
                    draft=""
                    onDraftChange={() => {}}
                    busy={false}
                    onAnswer={() => {}}
                    onDismiss={() => {}}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function InboxCard(props: {
  item: InboxItem;
  draft: string;
  onDraftChange: (v: string) => void;
  busy: boolean;
  onAnswer: () => void;
  onDismiss: () => void;
}) {
  const { item, draft, onDraftChange, busy, onAnswer, onDismiss } = props;
  const asker = item.askerUser?.name || item.askerUser?.email || "someone";
  const envLabel = item.env?.title || "—";

  return (
    <li>
      <Card
        className={cn(
          "p-4 space-y-3",
          item.status !== "pending" && "opacity-70"
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <Bot className="size-4 text-primary shrink-0" />
            <span className="font-mono text-sm font-medium truncate">
              {item.agent?.name || "(agent removed)"}
            </span>
            {item.agent?.kind === "member_clone" && (
              <Badge variant="outline" className="text-[10px] font-mono">
                clone
              </Badge>
            )}
            <span className="text-[11px] font-mono text-muted-foreground">
              · triggered by {asker} in {envLabel}
            </span>
          </div>
          {item.status === "answered" && (
            <Badge
              variant="outline"
              className="text-[10px] font-mono gap-1 bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
            >
              <Check className="size-3" />
              answered
            </Badge>
          )}
          {item.status === "dismissed" && (
            <Badge
              variant="outline"
              className="text-[10px] font-mono gap-1 text-muted-foreground"
            >
              dismissed
            </Badge>
          )}
        </div>

        <div className="text-sm whitespace-pre-wrap">{item.question}</div>

        {item.status === "pending" ? (
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              placeholder="Your answer…"
              rows={3}
              disabled={busy}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={onDismiss}
                disabled={busy}
              >
                <X className="size-3.5" />
                Dismiss
              </Button>
              <Button
                size="sm"
                onClick={onAnswer}
                disabled={busy || !draft.trim()}
              >
                <Check className="size-3.5" />
                {busy ? "Sending…" : "Send answer"}
              </Button>
            </div>
          </div>
        ) : item.answer ? (
          <div className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
            <div className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground mb-1">
              Your answer
            </div>
            <div className="whitespace-pre-wrap">{item.answer}</div>
          </div>
        ) : null}
      </Card>
    </li>
  );
}
