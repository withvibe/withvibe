"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { PluginIcon, type PluginPrefRow } from "./_plugin-panel";

export function PluginManageDialog({
  open,
  onOpenChange,
  workspaceId,
  envId,
  initialPrefs,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  workspaceId: string;
  envId: string;
  initialPrefs: PluginPrefRow[];
  onChanged: () => void;
}) {
  const [prefs, setPrefs] = useState<PluginPrefRow[]>(initialPrefs);
  const [pending, setPending] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setPrefs(initialPrefs);
  }, [initialPrefs]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return prefs;
    return prefs.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.scope.toLowerCase().includes(q)
    );
  }, [prefs, query]);

  async function toggle(pluginId: string, next: boolean) {
    setPending(pluginId);
    // Optimistic — the switch feels instant. Revert on error.
    setPrefs((rows) =>
      rows.map((r) => (r.id === pluginId ? { ...r, enabled: next } : r))
    );
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/envs/${envId}/plugins/${pluginId}/prefs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: next }),
        }
      );
      if (!res.ok) {
        setPrefs((rows) =>
          rows.map((r) =>
            r.id === pluginId ? { ...r, enabled: !next } : r
          )
        );
        const text = await res.text().catch(() => "");
        toast.error(text || `Failed (HTTP ${res.status})`);
        return;
      }
      onChanged();
    } finally {
      setPending(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Plugins in this env</DialogTitle>
          <DialogDescription>
            Hide plugins you don&apos;t need here. Env-scoped plugins also
            free up their container while disabled.
          </DialogDescription>
        </DialogHeader>
        {prefs.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            No plugins installed yet.
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by name, id, or scope…"
                className="pl-8 h-8 text-sm"
                autoFocus
              />
            </div>
            <div className="max-h-[60vh] overflow-y-auto -mx-6 px-6 border-t border-border/60">
              {filtered.length === 0 ? (
                <div className="text-xs text-muted-foreground py-6 text-center">
                  No matches.
                </div>
              ) : (
                <ul className="divide-y divide-border/60">
                  {filtered.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 py-2.5">
                      <PluginIcon
                        name={p.icon}
                        className="size-4 text-muted-foreground"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {p.name}
                        </div>
                        <div className="text-[11px] font-mono text-muted-foreground">
                          {p.id} · scope: {p.scope}
                        </div>
                      </div>
                      {pending === p.id && (
                        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                      )}
                      <Checkbox
                        checked={p.enabled}
                        disabled={pending === p.id}
                        onCheckedChange={(v) => toggle(p.id, v === true)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
