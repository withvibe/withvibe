"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";

type WorkspaceRunEvent =
  | { type: "snapshot"; envIds: string[] }
  | { type: "run_started"; envId: string; runId: string; sessionId: string }
  | {
      type: "run_ended";
      envId: string;
      runId: string;
      sessionId: string;
      status: "done" | "error" | "interrupted";
      error?: string;
    };

type Ctx = {
  runningEnvIds: Set<string>;
  /** Is env X currently running an agent turn? */
  isRunning: (envId: string) => boolean;
};

const ActiveRunsCtx = createContext<Ctx>({
  runningEnvIds: new Set(),
  isRunning: () => false,
});

export function useActiveRuns() {
  return useContext(ActiveRunsCtx);
}

/**
 * Opens one SSE connection for the workspace to track which envs currently
 * have a running agent turn, and fires a browser notification when a run
 * finishes while the user is not looking at that env's chat view.
 */
export function ActiveRunsProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: React.ReactNode;
}) {
  const [runningEnvIds, setRunningEnvIds] = useState<Set<string>>(new Set());
  // Per-env run-id refcount — two sessions in the same env can run in
  // parallel, so a single `run_ended` shouldn't clear the indicator while
  // another run is still in flight.
  const runIdsByEnvRef = useRef<Map<string, Set<string>>>(new Map());
  // envId → title, so the notification body reads naturally. Populated
  // lazily from /envs; falls back to the envId if the fetch fails.
  const titlesRef = useRef<Map<string, string>>(new Map());
  const pathnameRef = useRef<string>("");
  const pathname = usePathname();
  const router = useRouter();
  pathnameRef.current = pathname ?? "";

  // Fire-and-forget fetch of env titles for the notification body.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/envs`)
      .then((r) => (r.ok ? r.json() : null))
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        const m = new Map<string, string>();
        for (const e of list) {
          if (e && typeof e.id === "string" && typeof e.title === "string") {
            m.set(e.id, e.title);
          }
        }
        titlesRef.current = m;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    async function run() {
      while (!cancelled) {
        try {
          const res = await fetch(
            `/api/workspaces/${workspaceId}/active-runs/stream`,
            { signal: controller.signal }
          );
          if (!res.ok || !res.body) throw new Error(`status ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";
            for (const raw of parts) {
              if (!raw.startsWith("data:")) continue;
              const json = raw.slice(5).trim();
              if (!json) continue;
              let ev: WorkspaceRunEvent;
              try {
                ev = JSON.parse(json);
              } catch {
                continue;
              }
              handleEvent(ev);
            }
          }
        } catch (err) {
          if (cancelled) break;
          const aborted =
            controller.signal.aborted ||
            (err as { name?: string })?.name === "AbortError";
          if (aborted) break;
          // Brief backoff and retry; the workspace shell lives for the whole
          // session so we want to recover transparently.
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    function handleEvent(ev: WorkspaceRunEvent) {
      if (ev.type === "snapshot") {
        // Snapshot is already deduped by env on the server. Reset our
        // refcount map so it matches — we don't know individual runIds at
        // this point, so seed each env with a placeholder. Subsequent
        // start/end events use actual runIds and will replace this.
        const m = new Map<string, Set<string>>();
        for (const envId of ev.envIds) {
          m.set(envId, new Set([`__snapshot__:${envId}`]));
        }
        runIdsByEnvRef.current = m;
        setRunningEnvIds(new Set(ev.envIds));
      } else if (ev.type === "run_started") {
        const m = runIdsByEnvRef.current;
        let set = m.get(ev.envId);
        if (!set) {
          set = new Set();
          m.set(ev.envId, set);
        }
        // First time we see a real runId in this env, drop the placeholder.
        set.delete(`__snapshot__:${ev.envId}`);
        set.add(ev.runId);
        setRunningEnvIds((prev) => {
          if (prev.has(ev.envId)) return prev;
          const next = new Set(prev);
          next.add(ev.envId);
          return next;
        });
      } else if (ev.type === "run_ended") {
        const m = runIdsByEnvRef.current;
        const set = m.get(ev.envId);
        if (set) {
          set.delete(ev.runId);
          if (set.size === 0) m.delete(ev.envId);
        }
        setRunningEnvIds((prev) => {
          // Only clear the indicator when no run is still in flight for this env.
          if (m.get(ev.envId)) return prev;
          if (!prev.has(ev.envId)) return prev;
          const next = new Set(prev);
          next.delete(ev.envId);
          return next;
        });
        maybeNotify(ev);
      }
    }

    function maybeNotify(ev: Extract<WorkspaceRunEvent, { type: "run_ended" }>) {
      if (typeof window === "undefined") return;
      // Skip if the user is already looking at this env's chat page.
      const chatPath = `/workspaces/${workspaceId}/environments/${ev.envId}`;
      if (pathnameRef.current.startsWith(chatPath)) {
        console.debug(
          `[active-runs] skip notify for env=${ev.envId} — user on chat page`
        );
        return;
      }
      const title = titlesRef.current.get(ev.envId) ?? ev.envId;
      const isError = ev.status === "error";
      const body = isError
        ? `Agent run failed${ev.error ? `: ${ev.error}` : ""}`
        : "Agent finished the turn.";

      // Always show an in-app toast so the user gets feedback even if the
      // OS notification is blocked, denied, or the tab is foregrounded.
      const showToast = isError ? toast.error : toast.success;
      showToast(title, {
        description: body,
        action: {
          label: "Open",
          onClick: () => router.push(chatPath),
        },
      });

      // Try the native system notification too — only when permission is
      // granted. Log the reason if we skip so it's obvious in devtools.
      if (!("Notification" in window)) {
        console.debug("[active-runs] Notification API unavailable");
        return;
      }
      if (Notification.permission !== "granted") {
        console.debug(
          `[active-runs] Notification.permission=${Notification.permission} — skipping system notification`
        );
        return;
      }
      try {
        const n = new Notification(
          `${title} — ${isError ? "error" : "done"}`,
          {
            body,
            tag: `active-run:${ev.envId}`,
            icon: "/favicon.ico",
          }
        );
        n.onclick = () => {
          window.focus();
          router.push(chatPath);
          n.close();
        };
      } catch (err) {
        console.warn("[active-runs] Notification() threw:", err);
      }
    }

    void run();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [workspaceId]);

  // Request Notification permission on the first user gesture. Modern
  // Chrome/Safari silently reject requestPermission() without a gesture, so
  // calling it on mount is unreliable. We attach a one-shot click handler
  // instead and tear it down once permission is resolved.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) return;
    if (Notification.permission !== "default") {
      console.debug(
        `[active-runs] Notification.permission=${Notification.permission} (no prompt needed)`
      );
      return;
    }
    const onGesture = () => {
      Notification.requestPermission()
        .then((result) => {
          console.debug(`[active-runs] permission result=${result}`);
        })
        .catch(() => {});
      window.removeEventListener("click", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
    window.addEventListener("click", onGesture, { once: true });
    window.addEventListener("keydown", onGesture, { once: true });
    return () => {
      window.removeEventListener("click", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      runningEnvIds,
      isRunning: (envId: string) => runningEnvIds.has(envId),
    }),
    [runningEnvIds]
  );

  return (
    <ActiveRunsCtx.Provider value={value}>{children}</ActiveRunsCtx.Provider>
  );
}
