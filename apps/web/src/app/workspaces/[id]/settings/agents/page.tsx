"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Bot, Lock, Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";

type CloneOwner = { id: string; name: string | null; email: string } | null;

type AgentRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  builtIn: boolean;
  pinned: boolean;
  position: number;
  toolToggles: Record<string, boolean> | null;
  kind: "user_defined" | "member_clone";
  cloneForUserId: string | null;
  cloneForUser: CloneOwner;
  canEdit: boolean;
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
  toolToggles: Record<string, boolean> | null;
  builtIn: boolean;
  pinned: boolean;
  kind: "user_defined" | "member_clone";
  cloneForUser: CloneOwner;
  canEdit: boolean;
};

const TOOL_KEYS = [
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "glob",
  "webFetch",
  "webSearch",
] as const;

const TOOL_LABEL: Record<(typeof TOOL_KEYS)[number], string> = {
  bash: "Bash (shell)",
  read: "Read files",
  edit: "Edit files",
  write: "Write files",
  grep: "Grep (search)",
  glob: "Glob (file patterns)",
  webFetch: "Web fetch",
  webSearch: "Web search",
};

function isToolEnabled(
  toggles: Record<string, boolean> | null | undefined,
  key: string
): boolean {
  if (!toggles) return true;
  return toggles[key] !== false;
}

export default function WorkspaceAgentsPage(
  props: PageProps<"/workspaces/[id]/settings/agents">
) {
  const { id } = use(props.params);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneConfirmOpen, setCloneConfirmOpen] = useState(false);
  const [cloneCreating, setCloneCreating] = useState(false);
  const [editing, setEditing] = useState<AgentDetail | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${id}/agents`);
    if (res.ok) setAgents(await res.json());
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function openEdit(agent: AgentRow) {
    const res = await fetch(`/api/workspaces/${id}/agents/${agent.id}`);
    if (!res.ok) {
      toast.error("Couldn't load agent");
      return;
    }
    setEditing(await res.json());
  }

  async function confirmDeleteAgent() {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await fetch(
      `/api/workspaces/${id}/agents/${deleteTarget.id}`,
      { method: "DELETE" }
    );
    setDeleting(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error || d.message || "Failed to delete agent");
      return;
    }
    toast.success("Agent deleted");
    setDeleteTarget(null);
    await load();
  }

  async function confirmCreateClone() {
    setCloneCreating(true);
    const res = await fetch(`/api/workspaces/${id}/agents/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    setCloneCreating(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error || d.message || "Couldn't create clone");
      return;
    }
    const { id: newId } = await res.json();
    setCloneConfirmOpen(false);
    toast.success("Clone created — review the generated persona");
    await load();
    const detailRes = await fetch(`/api/workspaces/${id}/agents/${newId}`);
    if (detailRes.ok) setEditing(await detailRes.json());
  }

  return (
    <div className="max-w-5xl mx-auto p-6 sm:p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-mono font-bold tracking-tight">Agents</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Custom AI agents available in this workspace. Anyone can create or
            edit agents; built-in agents are read-only. You can also create a
            clone of yourself so teammates can ask it when you&apos;re
            unavailable.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setCloneConfirmOpen(true)}
            title="Create an AI clone of yourself"
          >
            <UserRound className="size-4" />
            Create my clone
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New agent
          </Button>
        </div>
      </div>

      {agents === null ? (
        <Skeleton className="h-40 rounded-md" />
      ) : agents.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No agents yet.
          </CardContent>
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60">
                <TableHead className="w-[26%]">Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="whitespace-nowrap">Tools</TableHead>
                <TableHead className="w-[100px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => {
                const isClone = a.kind === "member_clone";
                const cloneOwner = a.cloneForUser;
                const readOnlyReason = a.builtIn
                  ? "built-in — read-only"
                  : isClone && !a.canEdit
                    ? `clone of ${cloneOwner?.name || cloneOwner?.email || "someone"} — only they can edit`
                    : null;
                return (
                  <TableRow key={a.id} className="border-border/60 group">
                    <TableCell>
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 border border-primary/20 text-primary">
                          {isClone ? (
                            <UserRound className="size-4" />
                          ) : (
                            <Bot className="size-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="font-mono font-semibold truncate flex items-center gap-1.5">
                            {a.name}
                          </div>
                          <div className="text-[11px] text-muted-foreground font-mono truncate">
                            {a.slug}
                          </div>
                        </div>
                        {a.builtIn && (
                          <Badge
                            variant="outline"
                            className="text-[10px] font-mono gap-1"
                          >
                            <Lock className="size-3" />
                            built-in
                          </Badge>
                        )}
                        {isClone && (
                          <Badge
                            variant="outline"
                            className="text-[10px] font-mono gap-1"
                            title={
                              cloneOwner
                                ? `Clone of ${cloneOwner.name || cloneOwner.email}`
                                : "Clone"
                            }
                          >
                            <UserRound className="size-3" />
                            {a.canEdit
                              ? "your clone"
                              : `clone · ${cloneOwner?.name || cloneOwner?.email || "member"}`}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground line-clamp-2">
                      {a.description}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                      {toolSummary(a.toolToggles)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(a)}
                          title={a.canEdit ? "Edit" : readOnlyReason || "View"}
                        >
                          <Pencil className="size-4" />
                        </Button>
                        {a.canEdit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleteTarget(a)}
                            title="Delete"
                          >
                            <Trash2 className="size-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <AgentFormDialog
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        workspaceId={id}
        onSaved={load}
      />
      {editing && (
        <AgentFormDialog
          mode="edit"
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          workspaceId={id}
          agent={editing}
          onSaved={load}
        />
      )}

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && !deleting && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono flex items-center gap-2">
              <Trash2 className="size-4 text-destructive" />
              Delete agent?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              <span className="font-mono font-semibold">
                {deleteTarget?.name}
              </span>
              {deleteTarget?.kind === "member_clone"
                ? ", including any memory it has accumulated about you."
                : " and its skills."}{" "}
              Existing chat sessions are preserved but will show &ldquo;(agent
              removed)&rdquo;. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteAgent}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cloneConfirmOpen} onOpenChange={setCloneConfirmOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono flex items-center gap-2">
              <UserRound className="size-4" />
              Create an AI clone of yourself?
            </DialogTitle>
            <DialogDescription>
              We&apos;ll seed its persona from your profile and your recent
              messages using Claude Haiku. You can review and edit the result
              right after. Teammates can chat with your clone; only you can
              edit or delete it. If your clone doesn&apos;t know something it
              can escalate back to you via the inbox.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCloneConfirmOpen(false)}
              disabled={cloneCreating}
            >
              Cancel
            </Button>
            <Button onClick={confirmCreateClone} disabled={cloneCreating}>
              {cloneCreating ? "Creating…" : "Create clone"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toolSummary(toggles: Record<string, boolean> | null | undefined) {
  if (!toggles) return "all enabled";
  const disabled = TOOL_KEYS.filter((k) => toggles[k] === false);
  if (disabled.length === 0) return "all enabled";
  if (disabled.length === TOOL_KEYS.length) return "none";
  return `${TOOL_KEYS.length - disabled.length}/${TOOL_KEYS.length} enabled`;
}

function AgentFormDialog(props: {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  agent?: AgentDetail;
  onSaved: () => Promise<void> | void;
}) {
  const { mode, open, onOpenChange, workspaceId, agent, onSaved } = props;
  const readOnly = mode === "edit" && agent ? !agent.canEdit : false;

  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [greetingTemplate, setGreetingTemplate] = useState(
    agent?.greetingTemplate ?? ""
  );
  const [toolState, setToolState] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const k of TOOL_KEYS) out[k] = isToolEnabled(agent?.toolToggles, k);
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(agent?.name ?? "");
    setDescription(agent?.description ?? "");
    setSystemPrompt(agent?.systemPrompt ?? "");
    setGreetingTemplate(agent?.greetingTemplate ?? "");
    const next: Record<string, boolean> = {};
    for (const k of TOOL_KEYS) next[k] = isToolEnabled(agent?.toolToggles, k);
    setToolState(next);
    setError("");
  }, [open, agent]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    setSaving(true);
    setError("");

    const allEnabled = TOOL_KEYS.every((k) => toolState[k]);
    const toolTogglesPayload = allEnabled ? null : { ...toolState };

    const body = {
      name,
      description,
      systemPrompt,
      greetingTemplate: greetingTemplate.trim() || undefined,
      toolToggles: toolTogglesPayload,
    };

    const url =
      mode === "create"
        ? `/api/workspaces/${workspaceId}/agents`
        : `/api/workspaces/${workspaceId}/agents/${agent!.id}`;
    const res = await fetch(url, {
      method: mode === "create" ? "POST" : "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || d.message || "Save failed");
      return;
    }
    toast.success(mode === "create" ? "Agent created" : "Agent updated");
    onOpenChange(false);
    await onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[min(92vw,80rem)] max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle className="font-mono">
            {mode === "create"
              ? "Create agent"
              : readOnly
                ? `View ${agent?.name}`
                : `Edit ${agent?.name}`}
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? "Built-in agents can't be edited. Clone via a new custom agent if you want to change behavior."
              : "Agents are workspace-wide. You can enable or disable them per env from the env's agents panel."}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={submit}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="agent-name">Name</Label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Frontend reviewer"
                  disabled={readOnly}
                  className="font-mono"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="agent-desc">Description</Label>
                <Input
                  id="agent-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Reviews PRs for React/Next.js patterns and perf"
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="agent-prompt">Instructions (system prompt)</Label>
              <Textarea
                id="agent-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="You are a frontend code reviewer. Focus on..."
                rows={16}
                disabled={readOnly}
                className="font-mono text-xs resize-y min-h-[240px] max-h-[60vh]"
              />
              <p className="text-[11px] text-muted-foreground">
                Sets the agent&apos;s personality, focus, and behavior rules.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="agent-greeting">
                  First-message greeting{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional — AI generates one if empty)
                  </span>
                </Label>
                <Textarea
                  id="agent-greeting"
                  value={greetingTemplate}
                  onChange={(e) => setGreetingTemplate(e.target.value)}
                  placeholder="Leave blank to auto-generate a personal greeting."
                  rows={5}
                  disabled={readOnly}
                  className="text-xs resize-y"
                />
              </div>

              <div className="space-y-2">
                <Label>Tools available to the agent</Label>
                <div className="grid grid-cols-2 gap-2 rounded-md border border-border/60 p-3">
                  {TOOL_KEYS.map((k) => (
                    <Label
                      key={k}
                      className="flex items-center gap-2 text-xs font-normal cursor-pointer"
                    >
                      <Checkbox
                        checked={toolState[k] ?? true}
                        onCheckedChange={(v) =>
                          setToolState((s) => ({ ...s, [k]: v === true }))
                        }
                        disabled={readOnly}
                      />
                      <span>{TOOL_LABEL[k]}</span>
                    </Label>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Unchecking a tool tells the agent it isn&apos;t available
                  during chat. Leave all checked for full capability.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter className="px-6 py-4 border-t border-border/60 shrink-0">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {readOnly ? "Close" : "Cancel"}
            </Button>
            {!readOnly && (
              <Button type="submit" disabled={saving}>
                {saving
                  ? "Saving…"
                  : mode === "create"
                    ? "Create agent"
                    : "Save changes"}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
