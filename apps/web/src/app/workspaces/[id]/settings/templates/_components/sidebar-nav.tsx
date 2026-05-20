"use client";

import { Check, Circle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type SectionKey =
  | "basics"
  | "agent"
  | "services"
  | "variables"
  | "repos"
  | "runtime";

export type SectionStatus = "complete" | "incomplete" | "warning" | "optional";

export type SectionEntry = {
  key: SectionKey;
  label: string;
  status: SectionStatus;
  hint?: string;
};

export function SidebarNav({
  sections,
  activeKey,
  onSelect,
}: {
  sections: SectionEntry[];
  /** null when a file is open instead of a section — no row highlights. */
  activeKey: SectionKey | null;
  onSelect: (key: SectionKey) => void;
}) {
  return (
    <div className="py-3 text-sm">
      <SectionGroup title="Template">
        {sections.map((s) => (
          <SectionRow
            key={s.key}
            entry={s}
            active={s.key === activeKey}
            onClick={() => onSelect(s.key)}
          />
        ))}
      </SectionGroup>
    </div>
  );
}

function SectionGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2">
      <div className="px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function SectionRow({
  entry,
  active,
  onClick,
}: {
  entry: SectionEntry;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 text-left transition-colors text-sm border-l-2",
        active
          ? "bg-foreground/[0.06] border-foreground/40 text-foreground"
          : "border-transparent hover:bg-foreground/[0.04] text-muted-foreground hover:text-foreground"
      )}
      title={entry.hint}
    >
      <StatusDot status={entry.status} />
      <span className="font-mono">{entry.label}</span>
    </button>
  );
}

function StatusDot({ status }: { status: SectionStatus }) {
  if (status === "complete") {
    return <Check className="size-3.5 text-emerald-700/80 dark:text-emerald-500/80 shrink-0" />;
  }
  if (status === "warning") {
    return <AlertCircle className="size-3.5 text-yellow-600 dark:text-yellow-400 shrink-0" />;
  }
  if (status === "incomplete") {
    return <Circle className="size-3.5 text-muted-foreground/60 shrink-0" />;
  }
  return <Circle className="size-3.5 text-muted-foreground/30 shrink-0" />;
}

