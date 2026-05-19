"use client";

import * as React from "react";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Free-text branch field with filterable suggestions. Used by the template
 * editor: a template author may want to pin an existing branch (pick it from
 * the list) OR reference a branch that doesn't exist yet (type it freely).
 * Unlike the env-level `BranchCombobox` (strict select), the value here is
 * whatever the input holds — empty means "use the repo's default branch".
 * Built on Base UI's Autocomplete; styled to match `ui/select.tsx`.
 */
export function BranchAutocomplete({
  branches,
  value,
  onValueChange,
  defaultBranch,
  disabled,
  placeholder = "Repo default",
  className,
}: {
  branches: string[];
  value: string;
  onValueChange: (value: string) => void;
  defaultBranch?: string | null;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <AutocompletePrimitive.Root
      items={branches}
      value={value}
      onValueChange={(v) => onValueChange(v)}
      disabled={disabled}
      // Cap the rendered suggestions; the author narrows by typing.
      limit={100}
    >
      <div className="relative">
        <AutocompletePrimitive.Input
          placeholder={placeholder}
          className={cn(
            "flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 py-1 pr-8 text-sm font-mono shadow-xs transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
            className
          )}
        />
        <AutocompletePrimitive.Trigger
          aria-label="Show branches"
          className="absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground outline-none disabled:opacity-50"
        >
          <ChevronDownIcon className="size-4" />
        </AutocompletePrimitive.Trigger>
      </div>

      <AutocompletePrimitive.Portal>
        <AutocompletePrimitive.Positioner
          side="bottom"
          sideOffset={4}
          align="start"
          className="isolate z-50"
        >
          <AutocompletePrimitive.Popup
            data-slot="branch-autocomplete-content"
            className="relative isolate z-50 max-h-(--available-height) w-(--anchor-width) min-w-48 origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <AutocompletePrimitive.Empty className="px-2.5 py-3 text-center text-xs text-muted-foreground">
              No matching branch — it&apos;ll be used as typed
            </AutocompletePrimitive.Empty>
            <AutocompletePrimitive.List className="max-h-72 overflow-y-auto overflow-x-hidden p-1">
              {(branch: string) => (
                <AutocompletePrimitive.Item
                  key={branch}
                  value={branch}
                  className="relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1 pr-2 pl-1.5 text-sm font-mono outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <span className="line-clamp-1 flex-1">
                    {branch}
                    {branch === defaultBranch && (
                      <span className="text-muted-foreground"> (default)</span>
                    )}
                  </span>
                </AutocompletePrimitive.Item>
              )}
            </AutocompletePrimitive.List>
          </AutocompletePrimitive.Popup>
        </AutocompletePrimitive.Positioner>
      </AutocompletePrimitive.Portal>
    </AutocompletePrimitive.Root>
  );
}
