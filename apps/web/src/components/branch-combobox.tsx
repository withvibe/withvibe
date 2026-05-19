"use client";

import * as React from "react";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Searchable single-select branch picker. Mirrors the visual language of
 * `ui/select.tsx` (same trigger / popup / item classes) but adds a filter
 * input — the base-branch list can run to 100+ entries (env/* branches), so
 * a plain Select is unusable. Built on Base UI's Combobox (the primitive
 * library this app already uses); filtering is handled by the primitive.
 */
export function BranchCombobox({
  branches,
  value,
  onValueChange,
  defaultBranch,
  disabled,
  placeholder = "Base branch",
  className,
}: {
  branches: string[];
  value: string | null;
  onValueChange: (value: string) => void;
  defaultBranch?: string | null;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <ComboboxPrimitive.Root
      items={branches}
      value={value ?? null}
      onValueChange={(v) => {
        if (typeof v === "string") onValueChange(v);
      }}
      disabled={disabled}
      // Bound the rendered list for large repos — the user narrows with the
      // search box rather than scrolling hundreds of items.
      limit={100}
    >
      <ComboboxPrimitive.Trigger
        data-slot="branch-combobox-trigger"
        className={cn(
          "flex h-7 w-full items-center justify-between gap-1.5 rounded-[min(var(--radius-md),10px)] border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:border-ring dark:bg-input/30 dark:hover:bg-input/50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          className
        )}
      >
        <ComboboxPrimitive.Value placeholder={placeholder}>
          {(v: string | null) =>
            v ? (
              <span className="line-clamp-1 flex-1 text-left font-mono">
                {v}
                {v === defaultBranch && (
                  <span className="text-muted-foreground"> (default)</span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )
          }
        </ComboboxPrimitive.Value>
        <ComboboxPrimitive.Icon
          render={
            <ChevronDownIcon className="pointer-events-none size-4 text-muted-foreground" />
          }
        />
      </ComboboxPrimitive.Trigger>

      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner
          side="bottom"
          sideOffset={4}
          align="start"
          className="isolate z-50"
        >
          <ComboboxPrimitive.Popup
            data-slot="branch-combobox-content"
            className="relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-48 origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5">
              <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <ComboboxPrimitive.Input
                placeholder="Search branches…"
                className="h-8 w-full bg-transparent py-2 text-sm font-mono outline-none placeholder:text-muted-foreground"
              />
            </div>
            <ComboboxPrimitive.Empty className="px-2.5 py-3 text-center text-xs text-muted-foreground">
              No matching branch
            </ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List className="max-h-72 overflow-y-auto overflow-x-hidden p-1">
              {(branch: string) => (
                <ComboboxPrimitive.Item
                  key={branch}
                  value={branch}
                  className="relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm font-mono outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
                >
                  <span className="line-clamp-1 flex-1">
                    {branch}
                    {branch === defaultBranch && (
                      <span className="text-muted-foreground"> (default)</span>
                    )}
                  </span>
                  <ComboboxPrimitive.ItemIndicator
                    render={
                      <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
                    }
                  >
                    <CheckIcon className="pointer-events-none size-4" />
                  </ComboboxPrimitive.ItemIndicator>
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}
