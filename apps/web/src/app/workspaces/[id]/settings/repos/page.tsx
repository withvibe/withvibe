"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import {
  ExternalLink,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
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

// Inline GitHub brand icon (lucide doesn't ship one).
function GithubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

type Repo = {
  id: string;
  name: string;
  url: string;
  defaultForNewEnvs: boolean;
  cloneStatus: "pending" | "cloning" | "ready" | "error";
  branch: string | null;
  errorMsg: string | null;
  lastPulledAt: string | null;
};

type GithubRepo = {
  fullName: string;
  name: string;
  owner: string;
  avatar: string;
  description: string | null;
  private: boolean;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
  pushedAt: string | null;
};

const REPO_BADGE: Record<
  Repo["cloneStatus"],
  { label: string; className: string; dot: string }
> = {
  pending: {
    label: "pending",
    className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    dot: "bg-yellow-400 animate-pulse",
  },
  cloning: {
    label: "cloning",
    className: "bg-primary/10 text-primary border-primary/20",
    dot: "bg-primary animate-pulse",
  },
  ready: {
    label: "ready",
    className: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    dot: "bg-emerald-400",
  },
  error: {
    label: "error",
    className: "bg-destructive/10 text-destructive border-destructive/20",
    dot: "bg-destructive",
  },
};

export default function WorkspaceReposPage(
  props: PageProps<"/workspaces/[id]/settings/repos">
) {
  const { id } = use(props.params);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [role, setRole] = useState<"admin" | "member" | null>(null);
  const [githubConnected, setGithubConnected] = useState(false);
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [browseOpen, setBrowseOpen] = useState(false);

  const load = useCallback(async () => {
    const [wsRes, reposRes] = await Promise.all([
      fetch(`/api/workspaces/${id}`),
      fetch(`/api/workspaces/${id}/repos`),
    ]);
    if (wsRes.ok) {
      const ws = await wsRes.json();
      setRole(ws.role);
      setGithubConnected(Boolean(ws.githubConnected));
    }
    if (reposRes.ok) setRepos(await reposRes.json());
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!repos) return;
    const anyCloning = repos.some(
      (r) => r.cloneStatus === "pending" || r.cloneStatus === "cloning"
    );
    if (!anyCloning) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [repos, load]);

  async function addRepo(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError("");

    const res = await fetch(`/api/workspaces/${id}/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, branch: branch.trim() || undefined }),
    });

    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to add repo");
      setAdding(false);
      return;
    }

    setUrl("");
    setBranch("");
    setAdding(false);
    toast.success("Repo added — cloning in background");
    await load();
  }

  async function toggleDefault(repo: Repo) {
    await fetch(`/api/workspaces/${id}/repos/${repo.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultForNewEnvs: !repo.defaultForNewEnvs }),
    });
    await load();
  }

  async function removeRepo(repo: Repo) {
    if (!confirm(`Remove "${repo.name}"? This also deletes the local clone.`))
      return;
    await fetch(`/api/workspaces/${id}/repos/${repo.id}`, { method: "DELETE" });
    toast.success("Repo removed");
    await load();
  }

  async function retryRepo(repo: Repo) {
    const res = await fetch(`/api/workspaces/${id}/repos/${repo.id}/retry`, {
      method: "POST",
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error || d.message || "Failed to retry clone");
      return;
    }
    toast.success("Retrying clone…");
    await load();
  }

  const isAdmin = role === "admin";
  const connectedUrls = useMemo(
    () => new Set((repos || []).map((r) => r.url.toLowerCase())),
    [repos]
  );

  return (
    <div className="max-w-5xl mx-auto p-6 sm:p-8 space-y-6">
      <div>
        <h1 className="text-xl font-mono font-bold tracking-tight">
          Repositories
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Workspace-level GitHub repos. Attach them to environments when
          relevant.
        </p>
      </div>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-mono">
              Add a repository
            </CardTitle>
            <CardDescription>
              Browse your GitHub (if token connected) or paste an HTTPS URL.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => setBrowseOpen(true)}
                disabled={!githubConnected}
                title={
                  githubConnected
                    ? "Pick a repo from your GitHub account"
                    : "Connect a GitHub token in Settings first"
                }
              >
                <GithubIcon className="size-4" />
                Browse GitHub
              </Button>
              {!githubConnected && (
                <span className="text-xs text-muted-foreground self-center">
                  Connect a token in{" "}
                  <a
                    href={`/workspaces/${id}/settings`}
                    className="text-primary hover:underline"
                  >
                    Settings
                  </a>{" "}
                  to enable.
                </span>
              )}
            </div>

            <form onSubmit={addRepo} className="space-y-3">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-2">
                <Label htmlFor="url" className="text-xs text-muted-foreground">
                  Or paste a URL
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="url"
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://github.com/owner/repo"
                    className="font-mono flex-1"
                  />
                  <Input
                    id="branch"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="branch (optional)"
                    className="font-mono w-44"
                  />
                  <Button type="submit" variant="outline" disabled={adding || !url.trim()}>
                    <Plus className="size-4" />
                    {adding ? "Adding…" : "Add"}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Leave the branch empty to track the repo&apos;s default
                  branch. Envs can still be created off any branch regardless of
                  this choice.
                </p>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {repos === null ? (
        <Skeleton className="h-40 rounded-md" />
      ) : repos.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            No repositories yet.
          </CardContent>
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60">
                <TableHead className="w-[28%]">Name</TableHead>
                <TableHead>URL</TableHead>
                <TableHead className="w-[12%]">Status</TableHead>
                <TableHead className="w-[22%]">Default</TableHead>
                <TableHead className="w-[10%] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {repos.map((r) => (
                <RepoRow
                  key={r.id}
                  repo={r}
                  isAdmin={isAdmin}
                  onToggleDefault={() => toggleDefault(r)}
                  onRemove={() => removeRepo(r)}
                  onRetry={() => retryRepo(r)}
                />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <GithubBrowseDialog
        open={browseOpen}
        onOpenChange={setBrowseOpen}
        workspaceId={id}
        connectedUrls={connectedUrls}
        onAdded={load}
      />
    </div>
  );
}

function RepoRow({
  repo,
  isAdmin,
  onToggleDefault,
  onRemove,
  onRetry,
}: {
  repo: Repo;
  isAdmin: boolean;
  onToggleDefault: () => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const badge = REPO_BADGE[repo.cloneStatus] || REPO_BADGE.pending;

  return (
    <TableRow className="border-border/60 group">
      <TableCell>
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 border border-primary/20 text-primary group-hover:border-primary/40 transition-smooth">
            <GithubIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <div className="font-mono font-semibold truncate">
              {repo.name}
            </div>
            {repo.branch && (
              <div className="text-xs text-muted-foreground font-mono truncate">
                {repo.branch}
              </div>
            )}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        <a
          href={repo.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono hover:underline break-all"
        >
          <span className="line-clamp-1">{repo.url}</span>
          <ExternalLink className="size-3 shrink-0" />
        </a>
        {repo.errorMsg && (
          <div className="text-[11px] font-mono text-destructive mt-1 line-clamp-2 break-all">
            {repo.errorMsg}
          </div>
        )}
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
        <Label className="flex items-center gap-2 text-xs font-normal cursor-pointer">
          <Checkbox
            checked={repo.defaultForNewEnvs}
            onCheckedChange={onToggleDefault}
            disabled={!isAdmin}
          />
          <span className="text-muted-foreground">Attach to new envs</span>
        </Label>
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {isAdmin && repo.cloneStatus === "error" && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onRetry}
              title="Retry clone"
            >
              <RefreshCw className="size-4" />
            </Button>
          )}
          {isAdmin && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onRemove}
              title="Remove"
            >
              <Trash2 className="size-4 text-destructive" />
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function GithubBrowseDialog({
  open,
  onOpenChange,
  workspaceId,
  connectedUrls,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  connectedUrls: Set<string>;
  onAdded: () => Promise<void> | void;
}) {
  const [githubRepos, setGithubRepos] = useState<GithubRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setGithubRepos(null);
    fetch(`/api/workspaces/${workspaceId}/github/repos`)
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          setError(d.error || `GitHub error (${r.status})`);
          setGithubRepos([]);
          return;
        }
        const data = await r.json();
        setGithubRepos(data.repos || []);
      })
      .catch((e) => {
        setError(String(e));
        setGithubRepos([]);
      });
  }, [open, workspaceId]);

  const filtered = useMemo(() => {
    if (!githubRepos) return [];
    const q = query.trim().toLowerCase();
    if (!q) return githubRepos;
    return githubRepos.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q)
    );
  }, [githubRepos, query]);

  async function addFromGithub(g: GithubRepo) {
    setAdding(g.cloneUrl);
    const res = await fetch(`/api/workspaces/${workspaceId}/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: g.htmlUrl }),
    });
    setAdding(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error || "Failed to add repo");
      return;
    }
    toast.success(`${g.fullName} queued — cloning in background`);
    await onAdded();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono">
            <GithubIcon className="size-4" />
            Browse your GitHub repositories
          </DialogTitle>
          <DialogDescription>
            Repositories accessible by the connected token — own, collaborator,
            and org access.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or description…"
            className="pl-9"
            autoFocus
          />
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <ScrollArea className="h-[50vh] border rounded-md">
          {githubRepos === null ? (
            <div className="p-4 space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 rounded-md" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-12 text-center text-sm text-muted-foreground">
              {query.trim()
                ? `Nothing matches "${query}"`
                : "No repositories found"}
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {filtered.map((g) => {
                const already =
                  connectedUrls.has(g.cloneUrl.toLowerCase()) ||
                  connectedUrls.has(g.htmlUrl.toLowerCase()) ||
                  connectedUrls.has(
                    `${g.htmlUrl.toLowerCase()}.git`
                  );
                return (
                  <div
                    key={g.fullName}
                    className="p-3 flex items-start gap-3 hover:bg-muted/40 transition-smooth"
                  >
                    <img
                      src={`https://github.com/${g.owner}.png?size=40`}
                      alt=""
                      className="size-8 rounded-md border border-border"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <a
                          href={g.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono font-medium hover:text-primary transition-smooth"
                        >
                          {g.fullName}
                        </a>
                        {g.private && (
                          <Badge
                            variant="outline"
                            className="text-[10px] font-mono gap-1"
                          >
                            <Lock className="size-3" />
                            private
                          </Badge>
                        )}
                        {g.defaultBranch !== "main" && (
                          <span className="text-xs text-muted-foreground font-mono">
                            {g.defaultBranch}
                          </span>
                        )}
                      </div>
                      {g.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                          {g.description}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant={already ? "outline" : "default"}
                      disabled={already || adding === g.cloneUrl}
                      onClick={() => addFromGithub(g)}
                    >
                      {already ? (
                        "Added"
                      ) : adding === g.cloneUrl ? (
                        "Adding…"
                      ) : (
                        <>
                          <Plus className="size-4" />
                          Add
                        </>
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
