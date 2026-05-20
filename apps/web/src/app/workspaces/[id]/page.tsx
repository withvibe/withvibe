"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Check,
  ChevronRight,
  Copy,
  FileCode,
  Mail,
  Plus,
  Play,
  RefreshCw,
  Sparkles,
  Square,
} from "lucide-react";
import { useActiveRuns } from "./_active-runs";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Workspace = {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  envCount: number;
  repoCount: number;
  role: "admin" | "member";
  anthropicConnected: boolean;
  githubConnected: boolean;
  anthropicWorkspaceSet: boolean;
  githubWorkspaceSet: boolean;
};

type ContainerStatus =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "building"
  | "error";

type Environment = {
  id: string;
  title: string;
  description: string | null;
  containerStatus: ContainerStatus;
  containerPorts: Record<string, number> | null;
  serviceUrls: Record<string, string> | null;
  lastContainerAt: string | null;
  createdAt: string;
  createdBy: { name: string | null; email: string } | null;
  repos: { id: string; name: string }[];
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

export default function WorkspaceHomePage(
  props: PageProps<"/workspaces/[id]">
) {
  const { id } = use(props.params);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [envs, setEnvs] = useState<Environment[] | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const [wsRes, envRes] = await Promise.all([
      fetch(`/api/workspaces/${id}`),
      fetch(`/api/workspaces/${id}/envs`),
    ]);
    if (wsRes.ok) setWorkspace(await wsRes.json());
    if (envRes.ok) setEnvs(await envRes.json());
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while any container is transitioning
  useEffect(() => {
    if (!envs) return;
    const transitioning = envs.some((e) =>
      ["starting", "stopping", "building"].includes(e.containerStatus)
    );
    if (!transitioning) return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [envs, load]);

  async function containerAction(
    envId: string,
    action: "start" | "stop" | "rebuild"
  ) {
    setPending((p) => new Set(p).add(envId));
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
      toast.success(`Environment ${action === "start" ? "starting" : action === "stop" ? "stopping" : "rebuilding"}…`);
      await load();
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(envId);
        return n;
      });
    }
  }

  async function createInvite() {
    setInviteLoading(true);
    setCopied(false);
    try {
      const res = await fetch(`/api/workspaces/${id}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        toast.error("Failed to generate invite");
        return;
      }
      const data = await res.json();
      setInviteUrl(`${window.location.origin}/invite/${data.token}`);
    } finally {
      setInviteLoading(false);
    }
  }

  async function copyInvite() {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    toast.success("Invite link copied");
    setTimeout(() => setCopied(false), 2000);
  }

  if (!workspace || envs === null) {
    return (
      <div className="max-w-6xl mx-auto p-6 sm:p-8 space-y-6">
        <Skeleton className="h-14" />
        <Skeleton className="h-64 rounded-md" />
      </div>
    );
  }

  const setupTodo =
    !workspace.anthropicWorkspaceSet ||
    (workspace.repoCount === 0 && envs.length === 0);

  return (
    <div className="max-w-6xl mx-auto p-6 sm:p-8 space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-mono font-bold tracking-tight">
            {workspace.name}
          </h1>
          {workspace.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {workspace.description}
            </p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {workspace.role === "admin" && (
            <Button
              variant="outline"
              onClick={createInvite}
              disabled={inviteLoading}
            >
              <Mail className="size-4" />
              {inviteLoading ? "Generating…" : "Invite"}
            </Button>
          )}
          {workspace.role === "admin" && (
            <Button
              variant="outline"
              render={<Link href={`/workspaces/${id}/settings/templates`} />}
            >
              Manage templates
            </Button>
          )}
          <Button render={<Link href={`/workspaces/${id}/environments/new`} />}>
            <Plus className="size-4" />
            New environment
          </Button>
        </div>
      </div>

      {inviteUrl && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="py-4">
            <p className="text-sm font-medium mb-2">
              Share this link — expires in 7 days
            </p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={inviteUrl}
                className="font-mono text-xs"
              />
              <Button onClick={copyInvite}>
                {copied ? (
                  <>
                    <Check className="size-4" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-4" /> Copy
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {setupTodo && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Get set up</CardTitle>
            <CardDescription>
              Connect your integrations and add a repo so the AI has what it
              needs.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            <SetupItem
              done={workspace.anthropicWorkspaceSet}
              href={`/workspaces/${id}/settings`}
              text="Connect your Anthropic API key"
            />
            <SetupItem
              done={workspace.githubWorkspaceSet}
              href={`/workspaces/${id}/settings`}
              text="Connect GitHub (optional for public repos)"
            />
            <SetupItem
              done={workspace.repoCount > 0}
              href={`/workspaces/${id}/settings/repos`}
              text="Add at least one repository"
            />
            <SetupItem
              done={envs.length > 0}
              href={`/workspaces/${id}/environments/new`}
              text="Create your first environment"
            />
          </CardContent>
        </Card>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Environments
          </h2>
          <span className="text-xs text-muted-foreground">
            {envs.length} total
          </span>
        </div>

        {envs.length === 0 ? (
          <Card>
            <CardContent className="py-16 text-center space-y-4">
              <div className="mx-auto flex size-16 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <FileCode className="size-7" />
              </div>
              <div className="space-y-1">
                <h3 className="text-lg font-semibold font-mono">
                  No environments yet
                </h3>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  Create your first environment to start collaborating with
                  the AI on a focused piece of work.
                </p>
              </div>
              <Button
                render={<Link href={`/workspaces/${id}/environments/new`} />}
              >
                <Plus className="size-4" />
                New environment
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-border/60">
                  <TableHead className="w-[28%]">Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="w-[12%]">Status</TableHead>
                  <TableHead className="w-[18%] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {envs.map((e) => (
                  <EnvRow
                    key={e.id}
                    workspaceId={id}
                    env={e}
                    pending={pending.has(e.id)}
                    onAction={(action) => containerAction(e.id, action)}
                  />
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

    </div>
  );
}

function EnvRow({
  workspaceId,
  env,
  pending,
  onAction,
}: {
  workspaceId: string;
  env: Environment;
  pending: boolean;
  onAction: (action: "start" | "stop" | "rebuild") => void;
}) {
  const { isRunning: isAgentRunning } = useActiveRuns();
  const agentRunning = isAgentRunning(env.id);
  const badge = CONTAINER_BADGE[env.containerStatus] || CONTAINER_BADGE.stopped;
  const href = `/workspaces/${workspaceId}/environments/${env.id}`;
  const isRunning = env.containerStatus === "running";
  const isStopped = env.containerStatus === "stopped" || env.containerStatus === "error";
  const isTransitioning =
    env.containerStatus === "starting" ||
    env.containerStatus === "stopping" ||
    env.containerStatus === "building";

  return (
    <TableRow className="border-border/60 group">
      <TableCell>
        <Link href={href} className="block">
          <div className="flex items-center gap-3">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary/10 border border-primary/20 text-primary group-hover:border-primary/40 transition-smooth">
              <FileCode className="size-4" />
            </div>
            <span className="font-mono font-semibold group-hover:text-primary transition-smooth truncate">
              {env.title}
            </span>
            {agentRunning && (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary text-[10px] font-mono uppercase tracking-wide"
                title="Agent is running"
              >
                <Sparkles className="size-3 animate-pulse" />
                working
              </span>
            )}
          </div>
        </Link>
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        <span className="line-clamp-1">
          {env.description || <span className="text-muted-foreground/50 italic">No description</span>}
        </span>
      </TableCell>
      <TableCell>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-mono",
            badge.className
          )}
        >
          <span className={cn("size-1.5 rounded-full", badge.dot)} />
          {badge.label}
        </span>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            size="icon"
            variant="ghost"
            title="Start"
            disabled={pending || isRunning || isTransitioning}
            onClick={() => onAction("start")}
          >
            <Play className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Stop"
            disabled={pending || isStopped || isTransitioning}
            onClick={() => onAction("stop")}
          >
            <Square className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Rebuild"
            disabled={pending || isTransitioning}
            onClick={() => onAction("rebuild")}
          >
            <RefreshCw className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" render={<Link href={href} />}>
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function SetupItem({
  done,
  href,
  text,
}: {
  done: boolean;
  href: string;
  text: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 p-2 -mx-2 rounded-md hover:bg-muted/60 transition-smooth"
    >
      <span
        className={cn(
          "flex size-5 items-center justify-center rounded-full border",
          done
            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
            : "border-border text-muted-foreground"
        )}
      >
        {done && <Check className="size-3" />}
      </span>
      <span
        className={cn(
          "text-sm",
          done && "text-muted-foreground line-through"
        )}
      >
        {text}
      </span>
    </Link>
  );
}
