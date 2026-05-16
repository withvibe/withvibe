"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bot, FileText, Pin, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type AgentListItem = {
  id: string;
  slug: string;
  name: string;
  description: string;
  builtIn: boolean;
  pinned: boolean;
  skillCount: number;
  fileCount: number;
  disabledInEnv: boolean;
};

type AgentSkill = {
  id: string;
  slug: string;
  name: string;
  description: string;
  content: string;
  scope: "workspace" | "env";
  envId: string | null;
  source: "seed" | "user" | "ai_self" | "ai_from_correction";
  createdAt: string;
  updatedAt: string;
};

type AgentDetail = {
  id: string;
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  greetingTemplate: string;
  builtIn: boolean;
  pinned: boolean;
  canEdit: boolean;
  skills: AgentSkill[];
};

const SOURCE_LABEL: Record<AgentSkill["source"], { label: string; className: string }> = {
  seed: { label: "built-in", className: "bg-muted text-muted-foreground border-border" },
  user: { label: "user", className: "bg-primary/10 text-primary border-primary/20" },
  ai_self: {
    label: "AI learned",
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  },
  ai_from_correction: {
    label: "from correction",
    className: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  },
};

export function AgentsPanel({
  workspaceId,
  envId,
}: {
  workspaceId: string;
  envId: string;
}) {
  const [agents, setAgents] = useState<AgentListItem[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadList = useCallback(() => {
    fetch(`/api/workspaces/${workspaceId}/envs/${envId}/agents`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: AgentListItem[]) => setAgents(data))
      .catch(() => setAgents([]));
  }, [workspaceId, envId]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  async function toggleAgentDisabled(agent: AgentListItem, enabled: boolean) {
    setAgents((prev) =>
      prev
        ? prev.map((a) =>
            a.id === agent.id ? { ...a, disabledInEnv: !enabled } : a
          )
        : prev
    );
    const res = await fetch(
      `/api/workspaces/${workspaceId}/envs/${envId}/agents/${agent.id}/disabled`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: !enabled }),
      }
    );
    if (!res.ok) {
      toast.error("Couldn't update agent in env");
      loadList();
    }
  }

  const loadDetail = useCallback(
    async (agentId: string) => {
      setSelectedId(agentId);
      setDetailLoading(true);
      setDetail(null);
      setExpanded(null);
      try {
        const url = `/api/workspaces/${workspaceId}/agents/${agentId}?envId=${envId}`;
        const res = await fetch(url);
        if (res.ok) setDetail(await res.json());
      } finally {
        setDetailLoading(false);
      }
    },
    [workspaceId, envId]
  );

  if (selectedId) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 shrink-0">
          <button
            type="button"
            onClick={() => {
              setSelectedId(null);
              setDetail(null);
            }}
            className="inline-flex items-center gap-1 text-xs font-mono text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3" /> All agents
          </button>
          {detail?.pinned && (
            <Pin className="size-3 text-primary ml-auto" aria-label="Pinned" />
          )}
        </div>

        {detailLoading || !detail ? (
          <div className="p-4 space-y-3">
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto p-4 space-y-5">
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <Bot className="size-4 text-primary" />
                <h3 className="font-mono font-semibold">{detail.name}</h3>
                {detail.builtIn && (
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                    built-in
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {detail.description}
              </p>
            </section>

            <section className="space-y-2">
              <h4 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
                Persona
              </h4>
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-words bg-muted/40 rounded border p-2 max-h-60 overflow-auto">
                {detail.systemPrompt}
              </pre>
              {!detail.canEdit && (
                <p className="text-[10px] text-muted-foreground">
                  Read-only — built-in agent.
                </p>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
                  Skills
                </h4>
                <span className="text-[10px] font-mono text-muted-foreground">
                  {detail.skills.length} total
                </span>
              </div>
              {detail.skills.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No skills yet. The agent will save them as it learns.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {detail.skills.map((s) => {
                    const isOpen = expanded === s.id;
                    const srcMeta = SOURCE_LABEL[s.source];
                    return (
                      <li
                        key={s.id}
                        className="rounded-md border bg-card overflow-hidden"
                      >
                        <button
                          type="button"
                          className="w-full flex items-start gap-2 px-2.5 py-2 text-left hover:bg-muted/50 transition-smooth"
                          onClick={() => setExpanded(isOpen ? null : s.id)}
                        >
                          <Sparkles className="size-3.5 mt-0.5 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0 space-y-0.5">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-xs font-mono font-medium truncate">
                                {s.name}
                              </span>
                              <span
                                className={cn(
                                  "text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border",
                                  s.scope === "env"
                                    ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                                    : "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                )}
                              >
                                {s.scope}
                              </span>
                              <span
                                className={cn(
                                  "text-[9px] font-mono uppercase px-1.5 py-0.5 rounded border",
                                  srcMeta.className
                                )}
                              >
                                {srcMeta.label}
                              </span>
                            </div>
                            <p className="text-[10px] text-muted-foreground line-clamp-2">
                              {s.description}
                            </p>
                          </div>
                        </button>
                        {isOpen && (
                          <pre className="text-[10px] font-mono whitespace-pre-wrap break-words bg-background border-t border-border/60 p-2 max-h-80 overflow-auto">
                            {s.content}
                          </pre>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h4 className="text-xs font-mono font-semibold uppercase tracking-wide text-muted-foreground">
                Files
              </h4>
              <p className="text-xs text-muted-foreground">
                <FileText className="size-3.5 inline mr-1" />
                No attached files yet.
              </p>
            </section>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {agents === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : agents.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">
            No agents yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {agents.map((a) => (
              <li
                key={a.id}
                className={cn(
                  "relative flex items-start gap-3 rounded-md border bg-card px-3 py-2.5 hover:border-primary/40 transition-smooth",
                  a.disabledInEnv && "opacity-60"
                )}
              >
                <button
                  type="button"
                  className="flex-1 flex items-start gap-3 text-left min-w-0"
                  onClick={() => loadDetail(a.id)}
                >
                  <Bot className="size-4 mt-0.5 text-primary shrink-0" />
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-mono font-medium">
                        {a.name}
                      </span>
                      {a.pinned && (
                        <Pin
                          className="size-3 text-primary"
                          aria-label="Pinned"
                        />
                      )}
                      {a.builtIn && (
                        <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-muted text-muted-foreground border">
                          built-in
                        </span>
                      )}
                      {a.disabledInEnv && (
                        <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          disabled here
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground line-clamp-2">
                      {a.description}
                    </p>
                    <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
                      <span>{a.skillCount} skills</span>
                      <span>{a.fileCount} files</span>
                    </div>
                  </div>
                </button>
                <label
                  className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground cursor-pointer shrink-0"
                  onClick={(e) => e.stopPropagation()}
                  title={
                    a.disabledInEnv
                      ? "Enable this agent in this env"
                      : "Disable this agent in this env"
                  }
                >
                  <Checkbox
                    checked={!a.disabledInEnv}
                    onCheckedChange={(v) =>
                      toggleAgentDisabled(a, v === true)
                    }
                  />
                  <span>enabled</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
