"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import {
  POSITIONS,
  POSITION_LABELS,
  MAX_FREE_TEXT_LENGTH,
  MAX_POSITIONS,
  positionLabel,
} from "@withvibe/db/profile-constants";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const ITEM_HEIGHT = 36;
const VISIBLE_ITEMS = 4;
const DROPDOWN_MAX_HEIGHT = ITEM_HEIGHT * VISIBLE_ITEMS;

type Props = {
  positions: string[];
  onPositionsChange: (next: string[]) => void;
  label?: string;
  labelClassName?: string;
};

export function PositionSelect({
  positions,
  onPositionsChange,
  label = "Your position(s)",
  labelClassName,
}: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [maxHeight, setMaxHeight] = useState(DROPDOWN_MAX_HEIGHT);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = new Set(positions);

  const filteredKnown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...POSITIONS];
    return POSITIONS.filter((p) =>
      POSITION_LABELS[p].toLowerCase().includes(q)
    );
  }, [query]);

  const trimmedQuery = query.trim().slice(0, MAX_FREE_TEXT_LENGTH);
  const customExactMatch =
    trimmedQuery.length > 0 &&
    filteredKnown.some(
      (p) => POSITION_LABELS[p].toLowerCase() === trimmedQuery.toLowerCase()
    );
  const showAddCustom =
    trimmedQuery.length > 0 && !customExactMatch && !selected.has(trimmedQuery);

  type Item =
    | { kind: "known"; value: string; label: string }
    | { kind: "custom"; value: string; label: string };

  const items: Item[] = useMemo(() => {
    const out: Item[] = filteredKnown.map((p) => ({
      kind: "known",
      value: p,
      label: POSITION_LABELS[p],
    }));
    if (showAddCustom) {
      out.push({
        kind: "custom",
        value: trimmedQuery,
        label: trimmedQuery,
      });
    }
    return out;
  }, [filteredKnown, showAddCustom, trimmedQuery]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function measure() {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 16;
      const spaceBelow = window.innerHeight - rect.bottom - margin;
      setMaxHeight(
        Math.max(ITEM_HEIGHT * 2, Math.min(DROPDOWN_MAX_HEIGHT, spaceBelow))
      );
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  function add(value: string) {
    if (positions.length >= MAX_POSITIONS) return;
    if (selected.has(value)) return;
    onPositionsChange([...positions, value]);
    setQuery("");
    inputRef.current?.focus();
  }

  function remove(slug: string) {
    onPositionsChange(positions.filter((p) => p !== slug));
  }

  function activate(item: Item) {
    if (selected.has(item.value)) {
      remove(item.value);
    } else {
      add(item.value);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      if (open && items[activeIndex]) {
        e.preventDefault();
        activate(items[activeIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    } else if (
      e.key === "Backspace" &&
      query === "" &&
      positions.length > 0
    ) {
      remove(positions[positions.length - 1]);
    }
  }

  const atMax = positions.length >= MAX_POSITIONS;

  return (
    <div className="space-y-2">
      <Label className={labelClassName}>{label}</Label>
      <div ref={wrapperRef} className="relative">
        <div
          className="flex flex-wrap items-center gap-1.5 min-h-11 rounded-md border border-input bg-background/60 px-2 py-1.5 text-sm transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20"
          onClick={() => {
            setOpen(true);
            inputRef.current?.focus();
          }}
        >
          {positions.map((p) => (
            <span
              key={p}
              className="inline-flex items-center gap-1 rounded-md bg-primary/15 border border-primary/30 text-primary text-xs font-mono px-2 py-0.5"
            >
              {positionLabel(p)}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(p);
                }}
                className="hover:opacity-70"
                aria-label={`Remove ${positionLabel(p)}`}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={
              atMax
                ? `Max ${MAX_POSITIONS}`
                : positions.length === 0
                  ? "e.g. Backend Engineer"
                  : ""
            }
            disabled={atMax && !query}
            maxLength={MAX_FREE_TEXT_LENGTH}
            className="flex-1 min-w-[140px] bg-transparent outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />
        </div>

        {open && items.length > 0 && (
          <div
            className="absolute z-50 top-full left-0 right-0 mt-1 overflow-auto rounded-md border border-border bg-popover shadow-lg"
            style={{ maxHeight }}
          >
            {items.map((item, i) => {
              const isSelected = selected.has(item.value);
              const isActive = i === activeIndex;
              return (
                <button
                  key={`${item.kind}:${item.value}`}
                  type="button"
                  onMouseEnter={() => setActiveIndex(i)}
                  onClick={() => activate(item)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors",
                    isActive ? "bg-accent/20" : "hover:bg-accent/10",
                    isSelected && item.kind === "known" && "text-primary"
                  )}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {item.kind === "custom" && (
                      <Plus className="size-3.5 shrink-0 text-accent" />
                    )}
                    <span className="truncate">
                      {item.kind === "custom" ? (
                        <>
                          Add{" "}
                          <span className="font-mono text-accent">
                            &ldquo;{item.label}&rdquo;
                          </span>
                        </>
                      ) : (
                        item.label
                      )}
                    </span>
                  </span>
                  {isSelected && item.kind === "known" && (
                    <Check className="size-4" />
                  )}
                </button>
              );
            })}
          </div>
        )}

        {open && items.length === 0 && (
          <div
            className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border border-border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-lg"
          >
            No match
          </div>
        )}
      </div>
    </div>
  );
}
