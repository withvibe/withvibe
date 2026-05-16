import {
  Terminal as TerminalIcon,
  Users,
  Container,
  Sparkles,
  User,
} from "lucide-react";

export function AmbientBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10">
      <div className="animate-orb-1 absolute top-[-20%] left-[-15%] h-[600px] w-[600px] rounded-full bg-primary/20 blur-[140px]" />
      <div className="animate-orb-2 absolute bottom-[-25%] right-[-15%] h-[700px] w-[700px] rounded-full bg-accent/15 blur-[160px]" />
      <div className="absolute inset-0 bg-gradient-to-b from-background/0 via-background/0 to-background" />
    </div>
  );
}

export function FeatureChips() {
  return (
    <div className="grid grid-cols-3 gap-2 text-center">
      <FeatureChip icon={<TerminalIcon className="size-3" />} label="Controlled vibe" />
      <FeatureChip icon={<Container className="size-3" />} label="Isolated envs" />
      <FeatureChip icon={<Users className="size-3" />} label="Team-aware AI" />
    </div>
  );
}

function FeatureChip({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md border border-border/60 bg-card/30 px-1.5 py-1 font-mono text-[9px] uppercase text-muted-foreground backdrop-blur-sm">
      <span className="text-primary">{icon}</span>
      {label}
    </div>
  );
}

export function AppPreview() {
  return (
    <div
      className="animate-fade-up relative"
      style={{ animationDelay: "120ms" }}
    >
      <div className="pointer-events-none absolute -inset-4 -z-10 rounded-3xl bg-gradient-to-br from-primary/25 via-transparent to-accent/20 blur-2xl" />

      <div className="overflow-hidden rounded-xl border border-border/60 bg-card/70 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-border/60 bg-background/40 px-4 py-2.5 xl:px-5 xl:py-3">
          <div className="flex items-center gap-2">
            <span className="size-3 rounded-full bg-destructive/70" />
            <span className="size-3 rounded-full bg-warning/70" />
            <span className="size-3 rounded-full bg-success/70" />
            <span className="ml-3 font-mono text-xs xl:text-sm text-muted-foreground">
              withvibe · checkout-flow
            </span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2 py-0.5 font-mono text-[10px] xl:text-xs text-success">
            <span className="animate-pulse-dot size-1.5 rounded-full bg-success" />
            running
          </div>
        </div>

        <div className="grid grid-cols-[1.45fr_1fr]">
          <div className="space-y-4 xl:space-y-5 border-r border-border/60 p-4 xl:p-5">
            <UserBubble>add a checkout flow with stripe</UserBubble>

            <ThinkingBlock
              lines={[
                "Scanning apps/api routes…",
                "Adding /checkout + webhook handler…",
                "Running tests…",
              ]}
            />

            <AssistantBubble>
              Added{" "}
              <span className="font-mono text-primary">/checkout</span> and the
              stripe webhook handler. All tests passing — preview updated.
            </AssistantBubble>
          </div>

          <LogsPanel />
        </div>
      </div>
    </div>
  );
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 xl:gap-3">
      <div className="flex size-7 xl:size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <User className="size-3.5 xl:size-4" />
      </div>
      <div className="flex-1">
        <div className="mb-1 font-mono text-[10px] xl:text-xs text-muted-foreground">
          you
        </div>
        <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2 xl:px-3.5 xl:py-2.5 text-sm xl:text-[15px] text-foreground/90">
          {children}
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 xl:gap-3">
      <div className="flex size-7 xl:size-8 shrink-0 items-center justify-center rounded-full bg-accent/15">
        <Sparkles className="size-3.5 xl:size-4 text-accent" />
      </div>
      <div className="flex-1">
        <div className="mb-1 font-mono text-[10px] xl:text-xs text-muted-foreground">
          claude
        </div>
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 xl:px-3.5 xl:py-2.5 text-sm xl:text-[15px] text-foreground/95 shadow-[0_0_20px_hsl(207_90%_54%_/_0.12)]">
          {children}
        </div>
      </div>
    </div>
  );
}

function ThinkingBlock({ lines }: { lines: string[] }) {
  return (
    <div className="ml-10 xl:ml-11 rounded-md border border-border/60 bg-background/30 px-3 py-2 xl:px-3.5 xl:py-2.5">
      <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] xl:text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="animate-pulse-dot size-1.5 rounded-full bg-accent" />
        thinking
      </div>
      <ul className="space-y-0.5 font-mono text-[10px] xl:text-xs text-muted-foreground/80">
        {lines.map((l, i) => (
          <li key={i}>› {l}</li>
        ))}
      </ul>
    </div>
  );
}

function LogsPanel() {
  return (
    <div className="flex flex-col bg-background/40">
      <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-2 xl:px-4 xl:py-2.5 font-mono text-[10px] xl:text-xs uppercase tracking-wider text-muted-foreground">
        <span className="animate-pulse-dot size-1.5 rounded-full bg-accent" />
        live logs
      </div>
      <div className="flex-1 space-y-0.5 p-3 xl:p-4 font-mono text-[10px] xl:text-xs leading-relaxed">
        <LogLine t="12:34:01" service="api" text="POST /checkout 201" />
        <LogLine t="12:34:01" service="api" dim text="→ stripe cs_abc…" />
        <LogLine t="12:34:02" service="web" text="GET /checkout/ok" />
        <LogLine t="12:34:03" service="api" text="POST /webhook/stripe" />
        <LogLine
          t="12:34:03"
          service="api"
          color="success"
          text="✓ payment confirmed"
        />
        <LogLine
          t="12:34:04"
          service="tests"
          color="success"
          text="✓ 12 passed · 0 failed"
        />
        <LogLine t="12:34:05" service="web" dim text="HMR update · 1 file" />
        <div className="mt-1.5 flex items-center gap-1">
          <span className="text-primary">$</span>
          <span className="animate-caret inline-block h-2.5 w-[6px] translate-y-[1px] bg-primary" />
        </div>
      </div>
    </div>
  );
}

function LogLine({
  t,
  service,
  text,
  color,
  dim,
}: {
  t: string;
  service: string;
  text: string;
  color?: "success";
  dim?: boolean;
}) {
  const serviceColors: Record<string, string> = {
    api: "text-primary",
    web: "text-accent",
    tests: "text-success",
    db: "text-warning",
  };
  return (
    <div className="flex gap-1.5">
      <span className="shrink-0 text-muted-foreground/50">{t}</span>
      <span
        className={`w-9 shrink-0 ${serviceColors[service] ?? "text-muted-foreground"}`}
      >
        {service}
      </span>
      <span
        className={`flex-1 truncate ${
          color === "success"
            ? "text-success"
            : dim
              ? "text-muted-foreground/70"
              : "text-foreground/85"
        }`}
      >
        {text}
      </span>
    </div>
  );
}
