"use client";

import { type ReactNode } from "react";

/**
 * VS Code-style three-pane shell: header on top, sidebar on the left, AI panel
 * on the right, and the active editor / form in the center. The workspace shell
 * already eats its own h-14 header, so this fills the remaining viewport with
 * `100svh - 3.5rem` and keeps scrolling internal to each pane.
 */
export function IdeShell({
  header,
  sidebar,
  center,
  ai,
  sidebarWidth = "w-60",
  aiWidth = "w-[22rem]",
}: {
  header: ReactNode;
  sidebar: ReactNode;
  center: ReactNode;
  ai: ReactNode;
  sidebarWidth?: string;
  aiWidth?: string;
}) {
  return (
    <div className="flex flex-col bg-background h-[calc(100svh-3.5rem)]">
      <div className="border-b border-border/60 shrink-0 px-4 py-2.5 flex items-center gap-3">
        {header}
      </div>
      <div className="flex-1 flex min-h-0">
        <aside
          className={`${sidebarWidth} shrink-0 border-r border-border/60 overflow-y-auto bg-card/20`}
        >
          {sidebar}
        </aside>
        <main className="flex-1 min-w-0 overflow-y-auto">{center}</main>
        <aside
          className={`${aiWidth} shrink-0 border-l border-border/60 flex flex-col bg-card/20`}
        >
          {ai}
        </aside>
      </div>
    </div>
  );
}
