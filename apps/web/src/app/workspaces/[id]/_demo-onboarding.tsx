"use client";

import { useEffect, useState } from "react";
import { MessageSquare, MousePointerClick, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useDemoMode } from "./_demo-mode";

const STORAGE_KEY = "withvibe_demo_onboarded";

const STEPS = [
  {
    icon: MousePointerClick,
    title: "Welcome to the vibe-aquarium demo",
    body: "This workspace already has a live environment running for you. Click the aquarium environment in the list to open it.",
  },
  {
    icon: MessageSquare,
    title: "Tell the agent what to build",
    body: "Inside the environment, open the chat and describe what you want in your own words — any language works. The AI agent writes the code for you.",
  },
  {
    icon: Sparkles,
    title: "Watch it vibe code",
    body: "The agent edits the running app live. Use the preview to see your changes instantly, and the terminal / VS Code if you want to dig in.",
  },
] as const;

/**
 * One-time guided intro for public demo visitors. Shows only in demo mode and
 * only on a visitor's first arrival (tracked in localStorage, since every demo
 * account is fresh). Cosmetic onboarding — no server state.
 */
export function DemoOnboarding() {
  const demoMode = useDemoMode();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!demoMode) return;
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== "done") setOpen(true);
    } catch {
      // localStorage unavailable (private mode) — just show it this session.
      setOpen(true);
    }
  }, [demoMode]);

  function dismiss() {
    try {
      window.localStorage.setItem(STORAGE_KEY, "done");
    } catch {
      // ignore — worst case the visitor sees it again next load.
    }
    setOpen(false);
  }

  if (!demoMode) return null;

  const current = STEPS[step]!;
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing via backdrop / X counts as dismissal.
        if (!next) dismiss();
        else setOpen(true);
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20">
            <Icon className="size-5" />
          </div>
          <DialogTitle>{current.title}</DialogTitle>
          <DialogDescription>{current.body}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-center gap-1.5 pt-1">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={
                "h-1.5 rounded-full transition-all " +
                (i === step ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30")
              }
            />
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={dismiss}>
            Skip
          </Button>
          {isLast ? (
            <Button onClick={dismiss}>Start vibe coding →</Button>
          ) : (
            <Button onClick={() => setStep((s) => s + 1)}>Next</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
