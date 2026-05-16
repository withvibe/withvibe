"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  ScanLine,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type RepoStatus = {
  envRepoId: string;
  name: string;
  branch: string | null;
  baseBranch: string | null;
  envCloneStatus: string;
  ready: boolean;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  branchUrl: string | null;
  files: { path: string; index: string; workTree: string }[];
};

type DiffLine =
  | { kind: "header"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "ctx"; text: string; oldNo: number; newNo: number }
  | { kind: "del"; text: string; oldNo: number }
  | { kind: "add"; text: string; newNo: number };

type FileDiff = {
  path: string;
  oldPath: string | null;
  hunks: DiffLine[][];
};

type HistoryCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  timestamp: number;
  url: string | null;
};

type PullSuggestedAction = {
  id:
    | "ask-devops"
    | "retry"
    | "discard-local"
    | "confirm-discard"
    | "cancel"
    | "open-settings";
  label: string;
  description: string;
};

type PullNeedsAttention = {
  kind:
    | "dirty-blocked"
    | "diverged"
    | "merge-conflict"
    | "stash-pop-conflict"
    | "no-remote";
  message: string;
  conflictedFiles?: string[];
  suggestedActions: PullSuggestedAction[];
};

type PullResult = {
  ok: boolean;
  envRepoId: string;
  name: string;
  branch: string | null;
  mode: "auto-stash" | "discard";
  pulledCommits: number;
  stashed: boolean;
  stashRestored: boolean;
  backupRef: string | null;
  notice?: string;
  needsAttention?: PullNeedsAttention;
  error?: string;
};

type PullAllProgress = {
  total: number;
  current: number;
  results: PullResult[];
  done: boolean;
};

function keyFor(envRepoId: string | null, path: string): string {
  return `${envRepoId ?? ""}:::${path}`;
}

function statusLabel(index: string, workTree: string): {
  letter: string;
  className: string;
  title: string;
} {
  if (index === "?" && workTree === "?") {
    return { letter: "U", className: "text-muted-foreground", title: "Untracked" };
  }
  const s = index !== " " ? index : workTree;
  switch (s) {
    case "M":
      return { letter: "M", className: "text-yellow-400", title: "Modified" };
    case "A":
      return { letter: "A", className: "text-emerald-400", title: "Added" };
    case "D":
      return { letter: "D", className: "text-red-400", title: "Deleted" };
    case "R":
      return { letter: "R", className: "text-blue-400", title: "Renamed" };
    case "C":
      return { letter: "C", className: "text-blue-400", title: "Copied" };
    default:
      return { letter: s || "?", className: "text-muted-foreground", title: "Changed" };
  }
}

export function GitPanel({
  workspaceId,
  envId,
  onAskAgent,
  onRunSecurityScan,
}: {
  workspaceId: string;
  envId: string;
  onAskAgent?: (text: string) => void;
  /** Opens the Security scan panel and kicks off a fresh scan. */
  onRunSecurityScan?: () => void;
}) {
  const [summary, setSummary] = useState<RepoStatus[] | null>(null);
  const [allowDirectMerge, setAllowDirectMerge] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prOpen, setPrOpen] = useState(false);
  // Default is "all checked": we track the *unchecked* paths so new files that
  // appear after the next refresh are auto-included (opt-out model).
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [filesOpen, setFilesOpen] = useState(true);
  const [history, setHistory] = useState<HistoryCommit[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Pull / conflict modal state. `attention` is the latest "needs attention"
  // result from a single-repo pull; the modal stays open until the user picks
  // one of the suggested actions.
  const [attention, setAttention] = useState<PullResult | null>(null);
  const [pullAllProgress, setPullAllProgress] =
    useState<PullAllProgress | null>(null);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/summary`
      );
      if (!res.ok) {
        toast.error("Failed to load git status");
        return;
      }
      const data = (await res.json()) as {
        repos: RepoStatus[];
        allowDirectMerge?: boolean;
      };
      setSummary(data.repos);
      setAllowDirectMerge(Boolean(data.allowDirectMerge));
      if (!selected && data.repos.length > 0) {
        const firstDirty = data.repos.find((r) => r.dirty || r.ahead > 0);
        setSelected((firstDirty || data.repos[0]).envRepoId);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, envId, selected]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const selectedRepo = useMemo(
    () => summary?.find((r) => r.envRepoId === selected) ?? null,
    [summary, selected]
  );

  const loadDiff = useCallback(async () => {
    if (!selected) {
      setDiffText("");
      return;
    }
    setDiffLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${selected}/diff`
      );
      if (!res.ok) {
        setDiffText("");
        return;
      }
      const data = (await res.json()) as { text: string };
      setDiffText(data.text || "");
    } finally {
      setDiffLoading(false);
    }
  }, [workspaceId, envId, selected]);

  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  const fileDiffs = useMemo(() => parseUnifiedDiff(diffText), [diffText]);

  const loadHistory = useCallback(async () => {
    if (!selected) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${selected}/history`
      );
      if (!res.ok) {
        setHistory([]);
        return;
      }
      const data = (await res.json()) as { commits: HistoryCommit[] };
      setHistory(data.commits ?? []);
    } finally {
      setHistoryLoading(false);
    }
  }, [workspaceId, envId, selected]);

  // Refetch history whenever the section is open and the selected repo changes
  // (also after commits, since that invalidates the base..HEAD list).
  useEffect(() => {
    if (!historyOpen) return;
    loadHistory();
  }, [historyOpen, loadHistory]);

  async function suggestMessage() {
    if (!selected) return;
    setBusy("suggest");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${selected}/suggest-message`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.message || "Failed to suggest message");
        return;
      }
      setCommitMsg(data.message);
    } finally {
      setBusy(null);
    }
  }

  const selectedFiles = selectedRepo?.files ?? [];
  const checkedPaths = useMemo(
    () =>
      selectedFiles
        .filter((f) => !unchecked.has(keyFor(selected, f.path)))
        .map((f) => f.path),
    [selectedFiles, unchecked, selected]
  );

  function toggleFile(path: string) {
    if (!selected) return;
    const k = keyFor(selected, path);
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function setAllChecked(value: boolean) {
    if (!selected) return;
    setUnchecked((prev) => {
      const next = new Set(prev);
      for (const f of selectedFiles) {
        const k = keyFor(selected, f.path);
        if (value) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  async function commitOne() {
    if (!selected) return;
    if (!commitMsg.trim()) {
      toast.error("Enter a commit message");
      return;
    }
    if (checkedPaths.length === 0) {
      toast.error("Select at least one file");
      return;
    }
    // Send `paths` only when it's a true subset — otherwise omit so the
    // backend takes its "commit everything" fast path.
    const partial = checkedPaths.length < selectedFiles.length;
    setBusy("commit");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${selected}/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: commitMsg,
            ...(partial ? { paths: checkedPaths } : {}),
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.message || "Commit failed");
        return;
      }
      toast.success(`Committed ${data.sha?.slice(0, 7) ?? ""}`);
      setCommitMsg("");
      // Clear only the paths that were committed — uncommitted files stay
      // in whatever state the user left them.
      setUnchecked((prev) => {
        const next = new Set(prev);
        for (const p of checkedPaths) next.delete(keyFor(selected, p));
        return next;
      });
      await loadSummary();
      await loadDiff();
      if (historyOpen) await loadHistory();
    } finally {
      setBusy(null);
    }
  }

  async function commitAndPush() {
    if (!selected) return;
    if (!commitMsg.trim()) {
      toast.error("Enter a commit message");
      return;
    }
    if (checkedPaths.length === 0) {
      toast.error("Select at least one file");
      return;
    }
    const partial = checkedPaths.length < selectedFiles.length;
    setBusy("commit-push");
    try {
      const commitRes = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${selected}/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: commitMsg,
            ...(partial ? { paths: checkedPaths } : {}),
          }),
        }
      );
      const commitData = await commitRes.json();
      if (!commitRes.ok) {
        toast.error(commitData?.message || "Commit failed");
        return;
      }
      const pushRes = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${selected}/push`,
        { method: "POST" }
      );
      const pushData = await pushRes.json();
      if (!pushRes.ok) {
        // Commit succeeded, push didn't — be explicit.
        toast.error(`Committed ${commitData.sha?.slice(0, 7) ?? ""} but push failed: ${pushData?.message || "unknown"}`);
        await loadSummary();
        await loadDiff();
        if (historyOpen) await loadHistory();
        return;
      }
      toast.success(
        `Committed ${commitData.sha?.slice(0, 7) ?? ""} and pushed ${pushData.branch}`
      );
      setCommitMsg("");
      setUnchecked((prev) => {
        const next = new Set(prev);
        for (const p of checkedPaths) next.delete(keyFor(selected, p));
        return next;
      });
      await loadSummary();
      await loadDiff();
      if (historyOpen) await loadHistory();
    } finally {
      setBusy(null);
    }
  }

  async function commitAndPushAll() {
    if (!commitMsg.trim()) {
      toast.error("Enter a commit message");
      return;
    }
    setBusy("commit-push-all");
    try {
      const commitRes = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/all/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: commitMsg }),
        }
      );
      const commitData = await commitRes.json();
      if (!commitRes.ok) {
        toast.error(commitData?.message || "Commit-all failed");
        return;
      }
      const pushRes = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/all/push`,
        { method: "POST" }
      );
      const pushData = await pushRes.json();
      if (!pushRes.ok) {
        toast.error(pushData?.message || "Push-all failed");
        await loadSummary();
        return;
      }
      const okCount = (pushData.results || []).filter(
        (r: { ok: boolean }) => r.ok
      ).length;
      const total = (pushData.results || []).length;
      toast.success(`Committed and pushed ${okCount}/${total} repos`);
      setCommitMsg("");
      await loadSummary();
      await loadDiff();
      if (historyOpen) await loadHistory();
    } finally {
      setBusy(null);
    }
  }

  async function commitAll() {
    if (!commitMsg.trim()) {
      toast.error("Enter a commit message");
      return;
    }
    setBusy("commit-all");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/all/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: commitMsg }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.message || "Commit-all failed");
        return;
      }
      const okCount = (data.results || []).filter((r: { ok: boolean }) => r.ok).length;
      const total = (data.results || []).length;
      toast.success(`Committed ${okCount}/${total} repos`);
      setCommitMsg("");
      await loadSummary();
      await loadDiff();
      if (historyOpen) await loadHistory();
    } finally {
      setBusy(null);
    }
  }

  async function pushOne() {
    if (!selected) return;
    setBusy("push");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${selected}/push`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.message || "Push failed");
        return;
      }
      toast.success(`Pushed ${data.branch}`);
      await loadSummary();
    } finally {
      setBusy(null);
    }
  }

  async function pushAll() {
    setBusy("push-all");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/all/push`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.message || "Push failed");
        return;
      }
      const okCount = (data.results || []).filter((r: { ok: boolean }) => r.ok).length;
      const total = (data.results || []).length;
      toast.success(`Pushed ${okCount}/${total} repos`);
      await loadSummary();
    } finally {
      setBusy(null);
    }
  }

  // ---- pull (single + all) -------------------------------------------

  async function pullOne(
    envRepoId: string,
    opts: { mode?: "auto-stash" | "discard"; confirmDiscard?: boolean } = {}
  ): Promise<PullResult | null> {
    setBusy("pull");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${envRepoId}/pull`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(opts),
        }
      );
      const data = (await res.json()) as PullResult & { message?: string };
      if (!res.ok) {
        toast.error(data?.message || "Pull failed");
        return null;
      }
      if (data.needsAttention) {
        setAttention(data);
      } else if (data.ok) {
        toast.success(data.notice || "Pulled latest from GitHub");
      }
      await loadSummary();
      await loadDiff();
      if (historyOpen) await loadHistory();
      return data;
    } finally {
      setBusy(null);
    }
  }

  async function pullAll() {
    if (!summary || summary.length === 0) return;
    const ready = summary.filter((r) => r.ready);
    if (ready.length === 0) {
      toast.info("No ready repositories to pull.");
      return;
    }
    setBusy("pull-all");
    setPullAllProgress({
      total: ready.length,
      current: 0,
      results: [],
      done: false,
    });
    try {
      // Sequential — clearer per-repo progress for non-technical users, and
      // matches the backend's pullAll ordering. We hit the per-repo endpoint
      // (rather than /all/pull) so we can show progress as each repo completes.
      const results: PullResult[] = [];
      for (let i = 0; i < ready.length; i++) {
        const repo = ready[i];
        setPullAllProgress({
          total: ready.length,
          current: i,
          results,
          done: false,
        });
        try {
          const res = await fetch(
            `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${repo.envRepoId}/pull`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ mode: "auto-stash" }),
            }
          );
          const data = (await res.json()) as PullResult & { message?: string };
          if (!res.ok) {
            results.push({
              ok: false,
              envRepoId: repo.envRepoId,
              name: repo.name,
              branch: repo.branch,
              mode: "auto-stash",
              pulledCommits: 0,
              stashed: false,
              stashRestored: false,
              backupRef: null,
              error: data?.message || "Pull failed",
            });
          } else {
            results.push(data);
          }
        } catch (err) {
          results.push({
            ok: false,
            envRepoId: repo.envRepoId,
            name: repo.name,
            branch: repo.branch,
            mode: "auto-stash",
            pulledCommits: 0,
            stashed: false,
            stashRestored: false,
            backupRef: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      setPullAllProgress({
        total: ready.length,
        current: ready.length,
        results,
        done: true,
      });
      await loadSummary();
      await loadDiff();
      if (historyOpen) await loadHistory();
    } finally {
      setBusy(null);
    }
  }

  // ---- DevOps agent help bridge --------------------------------------

  function buildDevopsPrompt(repo: {
    name: string;
    branch: string | null;
    baseBranch: string | null;
  }, result: PullResult): string {
    const conflicted = result.needsAttention?.conflictedFiles ?? [];
    const lines = [
      `I tried to pull the latest changes from GitHub for the **${repo.name}** repository in this env, but I need help.`,
      "",
      `- Branch: \`${repo.branch || "?"}\` (base: \`${repo.baseBranch || "?"}\`)`,
      `- What happened: ${result.needsAttention?.message ?? result.notice ?? "Pull blocked."}`,
      `- Pull mode tried: \`${result.mode}\``,
    ];
    if (result.needsAttention?.kind) {
      lines.push(`- Issue type: \`${result.needsAttention.kind}\``);
    }
    if (conflicted.length > 0) {
      lines.push(
        "",
        "Conflicted files:",
        ...conflicted.slice(0, 20).map((f) => `- \`${f}\``)
      );
      if (conflicted.length > 20) {
        lines.push(`- …and ${conflicted.length - 20} more`);
      }
    }
    if (result.backupRef) {
      lines.push(
        "",
        `Safety net: a backup of my pre-pull state was saved at \`${result.backupRef}\`. The "Recover" endpoint can restore it: \`POST /workspaces/${workspaceId}/envs/${envId}/git/repos/${result.envRepoId}/recover\` with body \`{ "backupRef": "${result.backupRef}" }\`.`
      );
    }
    lines.push(
      "",
      "Please walk me through this in plain English (I'm not a git expert). When you're confident in the fix, you can run the steps yourself with `Bash` inside the env clone, or tell me which button to click in the Git panel:",
      "- **Throw away my changes and pull**: re-runs pull with mode `discard`",
      "- **Try again**: re-runs pull",
      "- **Recover**: restores from the backup ref above"
    );
    return lines.join("\n");
  }

  function askDevopsHelp(repo: {
    name: string;
    branch: string | null;
    baseBranch: string | null;
  }, result: PullResult) {
    if (!onAskAgent) {
      toast.info(
        "Open the chat and ask the DevOps agent — paste the conflict details when you do."
      );
      return;
    }
    onAskAgent(buildDevopsPrompt(repo, result));
    toast.info("Sent the conflict details to the DevOps agent.");
  }

  // Restore HEAD to the pre-pull backup ref. Used as the "undo" for users who
  // want to bail out of whatever state a pull left them in.
  async function recoverFromBackup(
    envRepoId: string,
    backupRef: string
  ): Promise<boolean> {
    setBusy("recover");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${envRepoId}/recover`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ backupRef }),
        }
      );
      const data = (await res.json()) as {
        ok: boolean;
        message?: string;
        restoredTo?: string | null;
      };
      if (!res.ok || !data.ok) {
        toast.error(
          data?.message || "Couldn't restore — the backup may have expired."
        );
        return false;
      }
      toast.success("Restored your repository to the pre-pull state.");
      await loadSummary();
      await loadDiff();
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function createPr() {
    if (!selected) return;
    setBusy("pr");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${selected}/pr`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: prTitle, body: prBody }),
        }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.message || "PR create failed");
        return;
      }
      toast.success(
        <span>
          PR #{data.number} created.{" "}
          <a
            href={data.url}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Open
          </a>
        </span>
      );
      setPrOpen(false);
      setPrTitle("");
      setPrBody("");
    } finally {
      setBusy(null);
    }
  }

  async function confirmMerge() {
    if (!selected) return;
    setBusy("merge");
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/git/repos/${selected}/merge`,
        { method: "POST" }
      );
      const data = await res.json();
      if (!res.ok) {
        toast.error(data?.message || "Merge failed");
        return;
      }
      if (data.merged === false) {
        toast.info(data.message || "Base branch already up to date");
      } else {
        toast.success(
          `Merged ${selectedRepo?.branch} into ${selectedRepo?.baseBranch} (${data.sha?.slice(0, 7) ?? ""})`
        );
      }
      setMergeOpen(false);
      await loadSummary();
      await loadDiff();
      if (historyOpen) await loadHistory();
    } finally {
      setBusy(null);
    }
  }

  if (!summary) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
        {loading ? "Loading…" : "No data"}
      </div>
    );
  }

  if (summary.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-sm text-muted-foreground text-center">
        No repositories attached to this environment.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Repo list */}
      <div className="border-b border-border/60 shrink-0">
        <div className="flex items-center justify-between px-3 py-1.5">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Repositories
          </span>
          <div className="flex items-center gap-1">
            {onRunSecurityScan && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-[10px] gap-1 px-2"
                onClick={onRunSecurityScan}
                title="Run an automated security scan of all code changes in this env"
              >
                <ScanLine className="size-3" />
                Security review
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              onClick={loadSummary}
              disabled={loading}
              title="Refresh"
            >
              <RefreshCw
                className={cn("size-3", loading && "animate-spin")}
              />
            </Button>
          </div>
        </div>
        <ul>
          {summary.map((r) => {
            const isActive = selected === r.envRepoId;
            const dirtyCount =
              r.staged + r.unstaged - (r.staged && r.unstaged ? 0 : 0);
            return (
              <li
                key={r.envRepoId}
                onClick={() => setSelected(r.envRepoId)}
                className={cn(
                  "px-3 py-1.5 cursor-pointer text-[11px] font-mono flex items-center gap-2 border-l-2",
                  isActive
                    ? "bg-primary/10 border-primary text-primary"
                    : "border-transparent hover:bg-muted text-foreground/85"
                )}
              >
                <GitBranch className="size-3 shrink-0 opacity-60" />
                <span className="truncate flex-1 min-w-0">{r.name}</span>
                {!r.ready ? (
                  <span className="text-[10px] opacity-60">{r.envCloneStatus}</span>
                ) : (
                  <span className="flex items-center gap-1.5 text-[10px]">
                    {r.dirty && (
                      <span
                        className="text-yellow-400"
                        title={`${dirtyCount} changed file(s)`}
                      >
                        ●{r.files.length}
                      </span>
                    )}
                    {r.ahead > 0 && (
                      <span className="text-emerald-400" title="Unpushed commits">
                        ↑{r.ahead}
                      </span>
                    )}
                    {r.behind > 0 && (
                      <span className="text-red-400" title="Behind upstream">
                        ↓{r.behind}
                      </span>
                    )}
                    {!r.dirty && r.ahead === 0 && r.behind === 0 && (
                      <Check className="size-3 text-emerald-400" />
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Selected repo header */}
      {selectedRepo && (
        <div className="px-3 py-2 border-b border-border/60 shrink-0 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-mono flex-wrap">
            <span className="text-muted-foreground">Env branch:</span>
            {selectedRepo.branchUrl ? (
              <a
                href={selectedRepo.branchUrl}
                target="_blank"
                rel="noreferrer"
                title="Open branch on GitHub"
                className="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 inline-flex items-center gap-1"
              >
                {selectedRepo.branch || "?"}
                <ExternalLink className="size-3 opacity-70" />
              </a>
            ) : (
              <code className="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                {selectedRepo.branch || "?"}
              </code>
            )}
            <span className="text-muted-foreground">←</span>
            <code className="text-foreground/80">{selectedRepo.baseBranch || "?"}</code>
          </div>
          <div className="flex items-center gap-1 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              disabled={busy != null || !selectedRepo.dirty}
              onClick={commitOne}
            >
              {busy === "commit" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <GitCommit className="size-3" />
              )}
              Commit
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              disabled={busy != null || !selectedRepo.dirty}
              onClick={commitAndPush}
              title="Commit and push the selected files"
            >
              {busy === "commit-push" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <ArrowUpFromLine className="size-3" />
              )}
              Commit &amp; Push
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              disabled={busy != null || selectedRepo.ahead === 0}
              onClick={pushOne}
            >
              {busy === "push" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <ArrowUpFromLine className="size-3" />
              )}
              Push
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              disabled={busy != null || !selectedRepo.ready}
              onClick={() => pullOne(selectedRepo.envRepoId)}
              title="Pull the latest changes from GitHub. If you have unsaved changes they'll be set aside and put back automatically."
            >
              {busy === "pull" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <ArrowDownToLine className="size-3" />
              )}
              Pull
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              disabled={busy != null}
              onClick={() => {
                setPrTitle(commitMsg.split("\n")[0] || "");
                setPrBody(commitMsg.split("\n").slice(1).join("\n").trim());
                setPrOpen((v) => !v);
              }}
            >
              <GitPullRequest className="size-3" />
              {prOpen ? "Cancel PR" : "Open PR"}
            </Button>
            {allowDirectMerge && (
              <Button
                size="sm"
                className="h-7 text-[11px] bg-amber-500/15 border border-amber-500/40 text-amber-300 hover:bg-amber-500/25 hover:text-amber-200"
                disabled={
                  busy != null ||
                  !selectedRepo.branch ||
                  !selectedRepo.baseBranch ||
                  selectedRepo.ahead > 0 ||
                  selectedRepo.dirty
                }
                onClick={() => setMergeOpen(true)}
                title={
                  selectedRepo.ahead > 0
                    ? "Push your commits first"
                    : selectedRepo.dirty
                      ? "Commit your changes first"
                      : `Merge ${selectedRepo.branch} directly into ${selectedRepo.baseBranch}`
                }
              >
                {busy === "merge" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <GitMerge className="size-3" />
                )}
                Merge
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 ml-auto"
                    disabled={busy != null}
                    aria-label="More git actions"
                    title="More actions"
                  >
                    {busy === "commit-all" ||
                    busy === "push-all" ||
                    busy === "commit-push-all" ||
                    busy === "pull-all" ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <MoreHorizontal className="size-3" />
                    )}
                  </Button>
                }
              />
              <DropdownMenuContent
                align="end"
                className="w-auto min-w-fit text-[11px] font-mono"
              >
                <DropdownMenuItem
                  onClick={commitAll}
                  className="text-[11px] py-1 [&_svg]:size-3 focus:bg-primary/10 focus:text-primary! focus:**:text-primary!"
                >
                  <GitCommit />
                  Commit all repos
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={pushAll}
                  className="text-[11px] py-1 [&_svg]:size-3 focus:bg-primary/10 focus:text-primary! focus:**:text-primary!"
                >
                  <ArrowUpFromLine />
                  Push all repos
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={commitAndPushAll}
                  className="text-[11px] py-1 [&_svg]:size-3 focus:bg-primary/10 focus:text-primary! focus:**:text-primary!"
                >
                  <ArrowUpFromLine />
                  Commit &amp; Push all repos
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={pullAll}
                  className="text-[11px] py-1 [&_svg]:size-3 focus:bg-primary/10 focus:text-primary! focus:**:text-primary!"
                >
                  <ArrowDownToLine />
                  Pull all repos from GitHub
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      )}

      {/* Commit message */}
      {selectedRepo && (
        <div className="px-3 py-2 border-b border-border/60 shrink-0 space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              Commit message
            </label>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[11px]"
              onClick={suggestMessage}
              disabled={busy != null || !selectedRepo.dirty}
              title="Ask AI to summarize the diff"
            >
              {busy === "suggest" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Sparkles className="size-3" />
              )}
              Suggest with AI
            </Button>
          </div>
          <Textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder={
              selectedRepo.dirty
                ? "Describe the change…"
                : "(no uncommitted changes)"
            }
            disabled={!selectedRepo.dirty}
            rows={2}
            className="resize-none text-xs font-mono bg-muted/40"
          />
        </div>
      )}

      {/* File list — pick which files to include in the commit */}
      {selectedRepo && selectedFiles.length > 0 && (
        <div className="border-b border-border/60 shrink-0">
          <div className="flex items-center gap-1 px-3 py-1.5">
            <button
              type="button"
              onClick={() => setFilesOpen((v) => !v)}
              className="flex items-center gap-1 hover:text-foreground text-muted-foreground"
              title={filesOpen ? "Collapse" : "Expand"}
            >
              {filesOpen ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              <span className="text-[10px] font-mono uppercase tracking-wider">
                Files
              </span>
            </button>
            <span className="text-[10px] font-mono text-muted-foreground">
              ({checkedPaths.length}/{selectedFiles.length} selected)
            </span>
            <div className="ml-auto flex items-center gap-2 text-[10px] font-mono">
              <button
                type="button"
                onClick={() => setAllChecked(true)}
                className="text-muted-foreground hover:text-foreground"
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setAllChecked(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                None
              </button>
            </div>
          </div>
          {filesOpen && (
            <ul className="max-h-48 overflow-y-auto">
              {selectedFiles.map((f) => (
                <FileRow
                  key={f.path}
                  file={f}
                  checked={!unchecked.has(keyFor(selected, f.path))}
                  onToggle={() => toggleFile(f.path)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* PR draft */}
      {prOpen && selectedRepo && (
        <div className="px-3 py-2 border-b border-border/60 shrink-0 space-y-1.5 bg-muted/20">
          <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Pull request
          </div>
          <Input
            value={prTitle}
            onChange={(e) => setPrTitle(e.target.value)}
            placeholder="PR title"
            className="h-7 text-xs font-mono"
          />
          <Textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            placeholder="PR description (optional)"
            rows={3}
            className="resize-none text-xs font-mono bg-card"
          />
          <Button
            size="sm"
            className="h-7 text-[11px] w-full"
            disabled={busy != null || !prTitle.trim()}
            onClick={createPr}
          >
            {busy === "pr" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <GitPullRequest className="size-3" />
            )}
            Create PR on GitHub
            <ExternalLink className="size-3 ml-1 opacity-60" />
          </Button>
        </div>
      )}

      {/* Diff */}
      <div className="flex-1 min-h-0 overflow-auto bg-card">
        {diffLoading ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin mr-2" />
            Loading diff…
          </div>
        ) : !diffText.trim() ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            No uncommitted changes.
          </div>
        ) : (
          <div className="space-y-3 p-2">
            {fileDiffs.map((fd, i) => (
              <FileDiffView key={i} file={fd} />
            ))}
          </div>
        )}
      </div>

      {/* History — commits on this branch since base */}
      {selectedRepo && (
        <div className="border-t border-border/60 shrink-0">
          <div className="flex items-center gap-1 px-3 py-1.5">
            <button
              type="button"
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex items-center gap-1 hover:text-foreground text-muted-foreground"
            >
              {historyOpen ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              <Clock className="size-3" />
              <span className="text-[10px] font-mono uppercase tracking-wider">
                History
              </span>
              {selectedRepo.ahead > 0 && (
                <span className="text-[10px] font-mono text-emerald-400 ml-1">
                  {selectedRepo.ahead} unpushed
                </span>
              )}
            </button>
            {historyOpen && (
              <button
                type="button"
                onClick={() => loadHistory()}
                className="ml-auto text-muted-foreground hover:text-foreground"
                title="Refresh history"
                disabled={historyLoading}
              >
                <RefreshCw
                  className={cn("size-3", historyLoading && "animate-spin")}
                />
              </button>
            )}
          </div>
          {historyOpen && (
            <div className="max-h-48 overflow-auto border-t border-border/60">
              {historyLoading && history.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted-foreground font-mono">
                  Loading…
                </div>
              ) : history.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-muted-foreground font-mono">
                  No commits on this branch yet.
                </div>
              ) : (
                <ul>
                  {history.map((c) => (
                    <HistoryRow key={c.sha} commit={c} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pull "needs your attention" modal — friendly explanation +
          plain-English action buttons. */}
      <NeedsAttentionDialog
        result={attention}
        onClose={() => setAttention(null)}
        onAction={async (action) => {
          if (!attention) return;
          if (action.id === "cancel") {
            setAttention(null);
            return;
          }
          if (action.id === "ask-devops") {
            askDevopsHelp(
              {
                name: attention.name,
                branch: attention.branch,
                baseBranch:
                  summary?.find((r) => r.envRepoId === attention.envRepoId)
                    ?.baseBranch ?? null,
              },
              attention
            );
            setAttention(null);
            return;
          }
          if (action.id === "retry") {
            setAttention(null);
            await pullOne(attention.envRepoId);
            return;
          }
          if (
            action.id === "discard-local" ||
            action.id === "confirm-discard"
          ) {
            setAttention(null);
            await pullOne(attention.envRepoId, {
              mode: "discard",
              confirmDiscard: true,
            });
            return;
          }
          if (action.id === "open-settings") {
            setAttention(null);
            window.open(
              `/workspaces/${workspaceId}/settings`,
              "_blank",
              "noreferrer"
            );
            return;
          }
        }}
        onRecover={async () => {
          if (!attention || !attention.backupRef) return;
          const ok = await recoverFromBackup(
            attention.envRepoId,
            attention.backupRef
          );
          if (ok) setAttention(null);
        }}
        busy={busy === "pull" || busy === "recover"}
      />

      {/* Pull-all sequential progress + summary. */}
      <PullAllDialog
        progress={pullAllProgress}
        onClose={() => setPullAllProgress(null)}
        onAskAgent={(result) => {
          const repo = summary?.find((r) => r.envRepoId === result.envRepoId);
          askDevopsHelp(
            {
              name: result.name,
              branch: result.branch,
              baseBranch: repo?.baseBranch ?? null,
            },
            result
          );
          setPullAllProgress(null);
        }}
        onRetry={async (envRepoId) => {
          await pullOne(envRepoId);
        }}
        busy={busy != null}
      />

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-amber-400 flex items-center gap-2">
              <GitMerge className="size-5" />
              Merge directly to {selectedRepo?.baseBranch || "base"}?
            </DialogTitle>
            <DialogDescription>
              This will merge{" "}
              <code className="px-1 py-0.5 rounded bg-muted font-mono">
                {selectedRepo?.branch}
              </code>{" "}
              into{" "}
              <code className="px-1 py-0.5 rounded bg-muted font-mono">
                {selectedRepo?.baseBranch}
              </code>{" "}
              on the <strong>origin</strong> repo (the one this env was cloned
              from) — <strong>no pull request</strong>, no review step. The
              changes go straight into{" "}
              <code className="px-1 py-0.5 rounded bg-muted font-mono">
                {selectedRepo?.baseBranch}
              </code>
              . This can&apos;t be undone from this panel.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMergeOpen(false)}
              disabled={busy === "merge"}
            >
              Cancel
            </Button>
            <Button
              className="bg-amber-500/20 border border-amber-500/50 text-amber-300 hover:bg-amber-500/30 hover:text-amber-200"
              onClick={confirmMerge}
              disabled={busy === "merge"}
            >
              {busy === "merge" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <GitMerge className="size-4" />
              )}
              Yes, merge to {selectedRepo?.baseBranch || "base"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}

function HistoryRow({ commit }: { commit: HistoryCommit }) {
  const relative = relativeTime(commit.timestamp);
  const inner = (
    <>
      <span className="font-mono text-[10px] text-muted-foreground shrink-0 w-14">
        {commit.shortSha}
      </span>
      <span
        className="truncate flex-1 min-w-0 text-[11px] font-mono"
        title={commit.subject}
      >
        {commit.subject}
      </span>
      <span
        className="text-[10px] font-mono text-muted-foreground shrink-0"
        title={`${commit.author} · ${new Date(commit.timestamp).toLocaleString()}`}
      >
        {relative}
      </span>
      {commit.url && <ExternalLink className="size-3 opacity-60 shrink-0" />}
    </>
  );
  const cls = "flex items-center gap-2 px-3 py-1 hover:bg-muted/40";
  return (
    <li>
      {commit.url ? (
        <a href={commit.url} target="_blank" rel="noreferrer" className={cls}>
          {inner}
        </a>
      ) : (
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
}

function FileRow({
  file,
  checked,
  onToggle,
}: {
  file: { path: string; index: string; workTree: string };
  checked: boolean;
  onToggle: () => void;
}) {
  const s = statusLabel(file.index, file.workTree);
  return (
    <li className="flex items-center gap-2 px-3 py-1 text-[11px] font-mono hover:bg-muted/40">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="size-3 shrink-0 cursor-pointer"
      />
      <span
        className={cn("w-4 text-center shrink-0", s.className)}
        title={s.title}
      >
        {s.letter}
      </span>
      <span className="truncate flex-1 min-w-0" title={file.path}>
        {file.path}
      </span>
    </li>
  );
}

// ---------- pull "needs attention" + pull-all dialogs ----------

const ACTION_TONE: Record<
  PullSuggestedAction["id"],
  { className: string; destructive?: boolean }
> = {
  "ask-devops": {
    className:
      "bg-primary/15 border-primary/40 text-primary hover:bg-primary/25",
  },
  retry: {
    className: "bg-card border-border hover:bg-muted text-foreground",
  },
  "discard-local": {
    className:
      "bg-red-500/15 border-red-500/40 text-red-300 hover:bg-red-500/25",
    destructive: true,
  },
  "confirm-discard": {
    className:
      "bg-red-500/15 border-red-500/40 text-red-300 hover:bg-red-500/25",
    destructive: true,
  },
  cancel: {
    className: "bg-card border-border hover:bg-muted text-muted-foreground",
  },
  "open-settings": {
    className: "bg-card border-border hover:bg-muted text-foreground",
  },
};

function NeedsAttentionDialog({
  result,
  onClose,
  onAction,
  onRecover,
  busy,
}: {
  result: PullResult | null;
  onClose: () => void;
  onAction: (action: PullSuggestedAction) => void | Promise<void>;
  onRecover: () => void | Promise<void>;
  busy: boolean;
}) {
  const open = result != null;
  const attention = result?.needsAttention ?? null;
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // Reset the second-step confirm when the dialog opens for a new repo.
  useEffect(() => {
    if (!open) setConfirmingDiscard(false);
  }, [open, result?.envRepoId]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-amber-400" />
            {result?.name}: needs your attention
          </DialogTitle>
          <DialogDescription>{attention?.message}</DialogDescription>
        </DialogHeader>

        {result?.notice && (
          <p className="text-xs text-muted-foreground -mt-2">{result.notice}</p>
        )}

        {attention?.conflictedFiles && attention.conflictedFiles.length > 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 max-h-40 overflow-auto">
            <div className="text-[10px] font-mono uppercase tracking-wider text-amber-400 mb-1">
              Files with conflicts ({attention.conflictedFiles.length})
            </div>
            <ul className="text-[11px] font-mono space-y-0.5">
              {attention.conflictedFiles.slice(0, 12).map((f) => (
                <li key={f} className="truncate" title={f}>
                  {f}
                </li>
              ))}
              {attention.conflictedFiles.length > 12 && (
                <li className="text-muted-foreground">
                  …and {attention.conflictedFiles.length - 12} more
                </li>
              )}
            </ul>
          </div>
        )}

        {result?.backupRef && (
          <div className="rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground flex items-start gap-2">
            <RotateCcw className="size-3.5 mt-0.5 shrink-0" />
            <span>
              Safety net: we saved your repository's state before this pull. You
              can restore it any time with the <strong>Restore</strong> button
              below.
            </span>
          </div>
        )}

        <div className="space-y-1.5">
          {(attention?.suggestedActions ?? []).map((action) => {
            const tone = ACTION_TONE[action.id];
            const isDiscard =
              action.id === "discard-local" ||
              action.id === "confirm-discard";
            const isAskAgent = action.id === "ask-devops";
            return (
              <button
                key={action.id}
                type="button"
                disabled={busy}
                onClick={() => {
                  if (isDiscard && !confirmingDiscard) {
                    setConfirmingDiscard(true);
                    return;
                  }
                  onAction(action);
                }}
                className={cn(
                  "w-full rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
                  tone.className
                )}
              >
                <div className="flex items-center gap-2 text-[12px] font-mono font-medium">
                  {isAskAgent && <Bot className="size-3.5" />}
                  {isDiscard && <TriangleAlert className="size-3.5" />}
                  {isDiscard && confirmingDiscard
                    ? "Yes — permanently delete my changes"
                    : action.label}
                </div>
                <div className="text-[11px] opacity-80 mt-0.5">
                  {isDiscard && confirmingDiscard
                    ? "This cannot be undone. Click again to confirm."
                    : action.description}
                </div>
              </button>
            );
          })}
        </div>

        <DialogFooter className="flex-row justify-between sm:justify-between">
          {result?.backupRef ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onRecover}
              className="text-[11px]"
            >
              {busy ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <RotateCcw className="size-3" />
              )}
              Restore pre-pull state
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={busy}
            className="text-[11px]"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PullAllDialog({
  progress,
  onClose,
  onAskAgent,
  onRetry,
  busy,
}: {
  progress: PullAllProgress | null;
  onClose: () => void;
  onAskAgent: (result: PullResult) => void;
  onRetry: (envRepoId: string) => void | Promise<void>;
  busy: boolean;
}) {
  const open = progress != null;
  if (!progress) {
    return (
      <Dialog open={false} onOpenChange={() => {}}>
        <DialogContent />
      </Dialog>
    );
  }
  const okCount = progress.results.filter((r) => r.ok && !r.needsAttention).length;
  const attentionCount = progress.results.filter(
    (r) => r.needsAttention || (!r.ok && !r.needsAttention)
  ).length;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && progress.done) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowDownToLine className="size-5 text-primary" />
            {progress.done
              ? "Pull all repos — finished"
              : "Pulling repos from GitHub…"}
          </DialogTitle>
          <DialogDescription>
            {progress.done ? (
              <>
                {okCount} of {progress.total} pulled successfully
                {attentionCount > 0
                  ? `, ${attentionCount} need your attention.`
                  : "."}
              </>
            ) : (
              <>
                {progress.current} of {progress.total} done. Working on the
                next one — please wait.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-72 overflow-auto rounded-md border bg-muted/30 divide-y divide-border/40">
          {progress.results.map((r) => (
            <PullAllRow
              key={r.envRepoId}
              result={r}
              onAskAgent={() => onAskAgent(r)}
              onRetry={() => onRetry(r.envRepoId)}
              busy={busy}
            />
          ))}
          {!progress.done && progress.results.length < progress.total && (
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] font-mono text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Pulling repository {progress.current + 1} of {progress.total}…
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            disabled={!progress.done || busy}
            className="text-[11px]"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PullAllRow({
  result,
  onAskAgent,
  onRetry,
  busy,
}: {
  result: PullResult;
  onAskAgent: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  const needsHelp = !!result.needsAttention || (!result.ok && !!result.error);
  return (
    <div className="px-3 py-2 text-[11px] font-mono">
      <div className="flex items-center gap-2">
        {needsHelp ? (
          <TriangleAlert className="size-3.5 text-amber-400 shrink-0" />
        ) : result.ok ? (
          <Check className="size-3.5 text-emerald-400 shrink-0" />
        ) : (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground shrink-0" />
        )}
        <span className="truncate flex-1 min-w-0" title={result.name}>
          {result.name}
        </span>
        {result.ok && result.pulledCommits > 0 && (
          <span className="text-[10px] text-emerald-400 shrink-0">
            +{result.pulledCommits}
          </span>
        )}
      </div>
      {(result.notice || result.needsAttention || result.error) && (
        <div className="mt-1 text-[10px] text-muted-foreground pl-5">
          {result.needsAttention?.message || result.notice || result.error}
        </div>
      )}
      {needsHelp && (
        <div className="mt-1.5 pl-5 flex items-center gap-2">
          <button
            type="button"
            onClick={onAskAgent}
            disabled={busy}
            className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline disabled:opacity-50"
          >
            <Bot className="size-3" />
            Ask DevOps agent
          </button>
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className="size-3" />
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- diff parsing + split-view rendering ----------

function parseUnifiedDiff(text: string): FileDiff[] {
  if (!text) return [];
  const lines = text.split("\n");
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: DiffLine[] | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const ln of lines) {
    if (ln.startsWith("diff --git ")) {
      if (current) files.push(current);
      // Try to extract the b/<path> portion
      const m = ln.match(/ b\/(.+)$/);
      const path = m ? m[1] : ln;
      current = { path, oldPath: null, hunks: [] };
      currentHunk = null;
      continue;
    }
    if (!current) {
      // Diff didn't start with `diff --git` (could be `diff --no-index` for
      // untracked files) — open a synthetic file entry from the next +++ line.
      if (ln.startsWith("+++ ")) {
        const path = ln.replace(/^\+\+\+ (b\/)?/, "");
        current = { path, oldPath: null, hunks: [] };
      }
      continue;
    }
    if (ln.startsWith("--- ")) {
      current.oldPath = ln.replace(/^--- (a\/)?/, "");
      continue;
    }
    if (ln.startsWith("+++ ")) {
      // already captured path from `diff --git`; ignore
      continue;
    }
    if (ln.startsWith("@@")) {
      const m = ln.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      currentHunk = [{ kind: "hunk", text: ln }];
      current.hunks.push(currentHunk);
      continue;
    }
    if (!currentHunk) continue;
    if (ln.startsWith("+") && !ln.startsWith("+++")) {
      currentHunk.push({ kind: "add", text: ln.slice(1), newNo });
      newNo++;
    } else if (ln.startsWith("-") && !ln.startsWith("---")) {
      currentHunk.push({ kind: "del", text: ln.slice(1), oldNo });
      oldNo++;
    } else if (ln.startsWith("\\")) {
      // "\ No newline at end of file" — skip
    } else {
      const t = ln.startsWith(" ") ? ln.slice(1) : ln;
      currentHunk.push({ kind: "ctx", text: t, oldNo, newNo });
      oldNo++;
      newNo++;
    }
  }
  if (current) files.push(current);
  return files;
}

function FileDiffView({ file }: { file: FileDiff }) {
  const [open, setOpen] = useState(true);
  const counts = useMemo(() => {
    let add = 0;
    let del = 0;
    for (const h of file.hunks) {
      for (const l of h) {
        if (l.kind === "add") add++;
        else if (l.kind === "del") del++;
      }
    }
    return { add, del };
  }, [file]);

  return (
    <div className="rounded-md border bg-background overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-1.5 bg-muted/40 border-b border-border/60 text-left hover:bg-muted/60"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <span className="font-mono text-[11px] truncate flex-1 min-w-0">
          {file.path}
        </span>
        <span className="font-mono text-[10px] text-emerald-400">+{counts.add}</span>
        <span className="font-mono text-[10px] text-red-400">−{counts.del}</span>
      </button>
      {open && (
        <div className="overflow-x-auto">
          {file.hunks.map((hunk, i) => (
            <SplitHunk key={i} hunk={hunk} />
          ))}
        </div>
      )}
    </div>
  );
}

// Pair adjacent del/add lines into the same row so the user sees old vs new
// side by side. Unpaired dels show empty on the right; unpaired adds empty on
// the left. Context spans both columns.
function SplitHunk({ hunk }: { hunk: DiffLine[] }) {
  type Row =
    | { kind: "header"; text: string }
    | {
        kind: "ctx";
        oldNo: number;
        newNo: number;
        text: string;
      }
    | {
        kind: "change";
        left: { no: number; text: string } | null;
        right: { no: number; text: string } | null;
      };

  const rows: Row[] = [];
  let i = 0;
  while (i < hunk.length) {
    const line = hunk[i];
    if (line.kind === "hunk") {
      rows.push({ kind: "header", text: line.text });
      i++;
      continue;
    }
    if (line.kind === "ctx") {
      rows.push({
        kind: "ctx",
        oldNo: line.oldNo,
        newNo: line.newNo,
        text: line.text,
      });
      i++;
      continue;
    }
    // Collect a run of dels followed by a run of adds; pair them.
    const dels: { no: number; text: string }[] = [];
    while (i < hunk.length && hunk[i].kind === "del") {
      const d = hunk[i] as Extract<DiffLine, { kind: "del" }>;
      dels.push({ no: d.oldNo, text: d.text });
      i++;
    }
    const adds: { no: number; text: string }[] = [];
    while (i < hunk.length && hunk[i].kind === "add") {
      const a = hunk[i] as Extract<DiffLine, { kind: "add" }>;
      adds.push({ no: a.newNo, text: a.text });
      i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let j = 0; j < max; j++) {
      rows.push({
        kind: "change",
        left: dels[j] ?? null,
        right: adds[j] ?? null,
      });
    }
  }

  return (
    <table className="w-full font-mono text-[11px] border-collapse">
      <tbody>
        {rows.map((row, i) => {
          if (row.kind === "header") {
            return (
              <tr key={i} className="bg-primary/5 text-primary/80">
                <td colSpan={4} className="px-2 py-0.5 select-none">
                  {row.text}
                </td>
              </tr>
            );
          }
          if (row.kind === "ctx") {
            return (
              <tr key={i} className="text-foreground/85">
                <td className="text-right pr-2 pl-2 text-muted-foreground/60 select-none w-10 align-top">
                  {row.oldNo}
                </td>
                <td className="px-2 whitespace-pre align-top w-1/2">{row.text}</td>
                <td className="text-right pr-2 pl-2 text-muted-foreground/60 select-none w-10 align-top">
                  {row.newNo}
                </td>
                <td className="px-2 whitespace-pre align-top w-1/2">{row.text}</td>
              </tr>
            );
          }
          return (
            <tr key={i}>
              <td
                className={cn(
                  "text-right pr-2 pl-2 select-none w-10 align-top",
                  row.left
                    ? "text-red-300/70 bg-red-500/10"
                    : "bg-muted/30"
                )}
              >
                {row.left?.no ?? ""}
              </td>
              <td
                className={cn(
                  "px-2 whitespace-pre align-top w-1/2",
                  row.left ? "bg-red-500/10 text-red-200" : "bg-muted/20"
                )}
              >
                {row.left?.text ?? ""}
              </td>
              <td
                className={cn(
                  "text-right pr-2 pl-2 select-none w-10 align-top",
                  row.right
                    ? "text-emerald-300/70 bg-emerald-500/10"
                    : "bg-muted/30"
                )}
              >
                {row.right?.no ?? ""}
              </td>
              <td
                className={cn(
                  "px-2 whitespace-pre align-top w-1/2",
                  row.right
                    ? "bg-emerald-500/10 text-emerald-200"
                    : "bg-muted/20"
                )}
              >
                {row.right?.text ?? ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
