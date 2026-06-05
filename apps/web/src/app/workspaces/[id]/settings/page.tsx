"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Bug,
  Check,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  MessageSquare,
  Plus,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { MODEL_OPTIONS, type ModelChoice } from "@/lib/models";
import { useDemoMode } from "../_demo-mode";

function GithubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

type KeyStatus = {
  workspaceSet: boolean;
  envFallback: boolean;
  connected: boolean;
};

type SlackStatus = {
  workspaceSet: boolean;
  connected: boolean;
  teamName: string | null;
  appTokenSet: boolean;
  twoWayEnabled: boolean;
};

type Integrations = {
  anthropic: KeyStatus;
  github: KeyStatus;
  slack: SlackStatus;
  allowDirectMerge: boolean;
  debugMode: boolean;
  defaultModel: ModelChoice;
  sandboxBypass: boolean | null;
};

type Role = "admin" | "member" | null;

export default function SettingsPage(
  props: PageProps<"/workspaces/[id]/settings">
) {
  const { id } = use(props.params);
  const demoMode = useDemoMode();
  const [data, setData] = useState<Integrations | null>(null);
  const [role, setRole] = useState<Role>(null);

  const load = useCallback(async () => {
    const [ws, integ] = await Promise.all([
      fetch(`/api/workspaces/${id}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/workspaces/${id}/settings/integrations`).then((r) =>
        r.ok ? r.json() : null
      ),
    ]);
    if (ws) setRole(ws.role);
    if (integ) setData(integ);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const isAdmin = role === "admin";

  return (
    <div className="max-w-3xl mx-auto px-6 sm:px-8 py-10 space-y-12">
      <header className="space-y-2">
        <h1 className="text-2xl font-mono font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          API keys, merge policy, and integrations for this workspace. These
          apply to every teammate.
        </p>
        {!isAdmin && role !== null && (
          <p className="text-xs text-muted-foreground pt-2">
            You&apos;re viewing in read-only mode — only workspace admins can
            change these values.
          </p>
        )}
        {demoMode && (
          <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
            <span className="font-medium">Demo mode — settings are read-only.</span>{" "}
            <span className="text-muted-foreground">
              Look around to see what&apos;s configurable, but changes can&apos;t
              be saved here.
            </span>
          </div>
        )}
      </header>

      {data === null ? (
        <div className="space-y-8">
          <Skeleton className="h-24 rounded-md" />
          <Skeleton className="h-24 rounded-md" />
          <Skeleton className="h-24 rounded-md" />
        </div>
      ) : (
        <>
          <Section
            title="AI"
            description="Claude powers the chat agents and commit-message suggestions."
          >
            {demoMode ? (
              <div className="rounded-md border border-border/60 bg-muted/30 px-4 py-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <Sparkles className="size-4" />
                  Anthropic API key
                  <Badge variant="outline" className="ml-1">
                    {data.anthropic?.connected ? "Connected" : "Not configured"}
                  </Badge>
                </div>
                <p className="mt-1.5 text-muted-foreground">
                  Managed by the demo operator (set at install via
                  ANTHROPIC_API_KEY). It can&apos;t be changed here in demo mode.
                </p>
              </div>
            ) : (
            <SecretField
              id={id}
              isAdmin={isAdmin}
              title="Anthropic API key"
              hint={
                <>
                  <span className="block">
                    Required for every AI feature. Two ways to get a key:
                  </span>
                  <span className="mt-1.5 block">
                    <span className="font-mono text-foreground">
                      Claude subscription
                    </span>{" "}
                    — run{" "}
                    <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
                      claude setup-token
                    </code>{" "}
                    in your terminal to generate a long-lived token from your
                    Max / Pro plan.
                  </span>
                  <span className="mt-1.5 block">
                    <span className="font-mono text-foreground">API key</span> —
                    create one at{" "}
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2 hover:opacity-80"
                    >
                      console.anthropic.com/settings/keys
                    </a>
                    .
                  </span>
                </>
              }
              icon={<Sparkles className="size-4" />}
              status={data.anthropic}
              fieldKey="anthropicApiKey"
              placeholder="sk-ant-…"
              envLabel="ANTHROPIC_API_KEY"
              onChange={load}
            />
            )}

            <Divider />

            <DefaultModelRow
              id={id}
              isAdmin={isAdmin}
              value={data.defaultModel}
              onChange={load}
            />

            <Divider />

            <SandboxBypassRow
              id={id}
              isAdmin={isAdmin}
              value={data.sandboxBypass}
              onChange={load}
            />
          </Section>

          <Section
            title="Source control"
            description="How we talk to GitHub and how the env branches make their way into your base branch."
          >
            <SecretField
              id={id}
              isAdmin={isAdmin}
              title="GitHub token"
              hint={
                <>
                  <span className="block">
                    Personal access token used to clone, push, and open PRs.
                    Needs the{" "}
                    <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
                      repo
                    </code>{" "}
                    and{" "}
                    <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
                      workflow
                    </code>{" "}
                    scopes.
                  </span>
                  <span className="mt-1.5 block">
                    <a
                      href="https://github.com/settings/tokens/new?description=WithVibe&scopes=repo,workflow"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary underline underline-offset-2 hover:opacity-80"
                    >
                      Create a classic token with the right scopes →
                    </a>
                  </span>
                </>
              }
              icon={<GithubIcon className="size-4" />}
              status={data.github}
              fieldKey="githubToken"
              placeholder="ghp_…"
              envLabel="GITHUB_TOKEN"
              onChange={load}
            />

            <Divider />

            <DirectMergeRow
              id={id}
              isAdmin={isAdmin}
              value={data.allowDirectMerge}
              onChange={load}
            />
          </Section>

          <Section
            title="Communication"
            description="Where the AI can post updates and ask teammates when it needs human input."
            beta
          >
            <SlackField
              id={id}
              isAdmin={isAdmin}
              status={data.slack}
              onChange={load}
            />
            <Divider />
            <SlackAppTokenField
              id={id}
              isAdmin={isAdmin}
              status={data.slack}
              onChange={load}
            />
          </Section>

          <Section
            title="Storage"
            description="Where compose files and env assets are written. Defaults to local disk on the API host; switch to S3 to store across machines."
          >
            <StorageSection id={id} isAdmin={isAdmin} />
          </Section>

          <Section
            title="Environments"
            description="Templates teammates pick from when creating a new env."
          >
            <SettingRow
              icon={<Layers className="size-4" />}
              title="Templates"
              hint="Pre-built docker-compose stacks with placeholder variables. The orchestrator fills in ports and paths so multiple envs can run side by side."
            >
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  render={
                    <Link href={`/workspaces/${id}/settings/templates`} />
                  }
                >
                  Manage templates
                </Button>
              </div>
            </SettingRow>
          </Section>

          <Section
            title="Secrets"
            description="Named values injected into envs at materialization time. Templates reference them via variables of kind 'secret' (matched on the name)."
          >
            <SettingRow
              icon={<KeyRound className="size-4" />}
              title="Workspace secrets"
              hint="Scoped to this workspace only. Values are never returned by the API after they're saved — to rotate one, edit the value and save again. Falls back to the API process env if no workspace value is set."
            >
              <SecretsManager id={id} isAdmin={isAdmin} />
            </SettingRow>
          </Section>

          <Section
            title="Developer"
            description="Tools for debugging slow chat turns and inspecting what the agent is doing."
          >
            <DebugModeRow
              id={id}
              isAdmin={isAdmin}
              value={data.debugMode}
              onChange={load}
            />
          </Section>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  description,
  beta,
  children,
}: {
  title: string;
  description: string;
  beta?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-base font-mono font-semibold tracking-tight flex items-center gap-2">
          {title}
          {beta && (
            <Badge
              variant="outline"
              className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0 h-4 text-amber-400 border-amber-400/40 bg-amber-400/10"
            >
              beta
            </Badge>
          )}
        </h2>
        <p className="text-xs text-muted-foreground max-w-prose">
          {description}
        </p>
      </div>
      <div className="rounded-lg border border-border/60 bg-card/30 divide-y divide-border/60">
        {children}
      </div>
    </section>
  );
}

function Divider() {
  // Not rendered as a <hr/>; the parent uses `divide-y` so siblings get the
  // border automatically. This placeholder exists only to make section rows
  // appear as distinct children.
  return null;
}

function SettingRow({
  icon,
  title,
  hint,
  badge,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  hint: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-4 p-4 sm:p-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:gap-8">
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          {icon && (
            <span className="flex size-6 shrink-0 items-center justify-center rounded bg-primary/10 text-primary border border-primary/20">
              {icon}
            </span>
          )}
          <span className="font-mono text-sm font-semibold">{title}</span>
          {badge}
        </div>
        <p className="text-xs text-muted-foreground max-w-prose">{hint}</p>
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: KeyStatus }) {
  if (status.workspaceSet) {
    return (
      <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 gap-1 font-mono text-[10px]">
        <Check className="size-3" /> Connected
      </Badge>
    );
  }
  if (status.envFallback) {
    return (
      <Badge variant="secondary" className="gap-1 font-mono text-[10px]">
        <Check className="size-3" /> Env fallback
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="gap-1 text-muted-foreground font-mono text-[10px]"
    >
      <X className="size-3" /> Not connected
    </Badge>
  );
}

function SecretField({
  id,
  isAdmin,
  title,
  hint,
  icon,
  status,
  fieldKey,
  placeholder,
  envLabel,
  onChange,
}: {
  id: string;
  isAdmin: boolean;
  title: string;
  hint: React.ReactNode;
  icon: React.ReactNode;
  status: KeyStatus;
  fieldKey: "anthropicApiKey" | "githubToken";
  placeholder: string;
  envLabel: string;
  onChange: () => void;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  async function save() {
    setSaving(true);
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [fieldKey]: value.trim() || null }),
    });
    setSaving(false);
    if (res.ok) {
      setValue("");
      toast.success(`${title} saved`);
      onChange();
    } else {
      toast.error("Failed to save");
    }
  }

  async function clearKey() {
    if (!confirm(`Remove saved ${title.toLowerCase()} from this workspace?`))
      return;
    setClearing(true);
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [fieldKey]: null }),
    });
    setClearing(false);
    if (res.ok) {
      toast.success(`${title} disconnected`);
      onChange();
    }
  }

  return (
    <SettingRow
      icon={icon}
      title={title}
      hint={hint}
      badge={<StatusBadge status={status} />}
    >
      {status.envFallback && !status.workspaceSet && (
        <p className="text-xs text-muted-foreground font-mono">
          Using <code className="px-1 bg-muted rounded">{envLabel}</code> from
          the server env. Set a workspace key to override.
        </p>
      )}
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">
          Admins only. The saved value is never shown again after it&apos;s set.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={fieldKey} className="text-xs font-mono">
              {status.workspaceSet ? "Replace" : "Add key"}
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id={fieldKey}
                  type={reveal ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono pr-9"
                />
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={reveal ? "Hide" : "Reveal"}
                >
                  {reveal ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
              <Button
                onClick={save}
                disabled={!value.trim() || saving}
                size="sm"
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
          {status.workspaceSet && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive h-7 px-2 text-xs"
              onClick={clearKey}
              disabled={clearing}
            >
              {clearing ? "Removing…" : "Disconnect"}
            </Button>
          )}
        </>
      )}
    </SettingRow>
  );
}

// Pre-filled app manifest for Slack's "Create app from manifest" flow.
// Slack lets you drop the manifest into the URL via the `manifest_json` query
// param (see docs.slack.dev/app-manifests/configuring-apps-with-app-manifests)
// — clicking the link lands the user on a Create-App form with these scopes
// already populated, so they just confirm + install + grab the bot token.
//
// Bot scopes here cover Phase 2 (notify) + Phase 3 (ask/answer):
//   chat:write          post messages
//   chat:write.public   post in public channels without joining
//   im:write            open DMs to teammates
//   users:read          enumerate workspace users
//   users:read.email    resolve member ↔ Slack-user by email
const SLACK_APP_MANIFEST = {
  display_information: {
    name: "WithVibe",
    description:
      "AI agents post updates and ask teammates questions on Slack.",
  },
  features: {
    bot_user: { display_name: "WithVibe", always_online: true },
    // Messages tab enabled (read-only off) so users can REPLY to the bot's
    // DMs. Without this, Slack shows "Sending messages to this app has been
    // turned off" on every DM the agent sends.
    app_home: {
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
  },
  oauth_config: {
    scopes: {
      bot: [
        "chat:write",
        "chat:write.public",
        "im:write",
        "files:write",
        "users:read",
        "users:read.email",
      ],
    },
  },
  settings: {
    // Socket Mode + event subscriptions = the two-way Q&A path. With these
    // pre-enabled, the only thing the admin still has to do by hand is
    // generate the app-level token (`xapp-...`) — Slack doesn't put
    // app-level tokens in the manifest, they're created in the UI per app.
    event_subscriptions: {
      bot_events: ["message.im", "message.channels", "message.groups"],
    },
    socket_mode_enabled: true,
    org_deploy_enabled: false,
    token_rotation_enabled: false,
  },
};
const SLACK_NEW_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(SLACK_APP_MANIFEST))}`;

function SlackField({
  id,
  isAdmin,
  status,
  onChange,
}: {
  id: string;
  isAdmin: boolean;
  status: SlackStatus;
  onChange: () => void;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackBotToken: value.trim() || null }),
    });
    setSaving(false);
    if (res.ok) {
      setValue("");
      toast.success("Slack connected");
      onChange();
    } else {
      // Surface the real Slack error (invalid_auth, missing_scope, etc.) —
      // validating in PATCH means the server returns a 400 with the reason.
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      const msg = j.message || "Failed to save";
      setError(msg);
      toast.error(msg);
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect Slack from this workspace?")) return;
    setClearing(true);
    setError("");
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackBotToken: null }),
    });
    setClearing(false);
    if (res.ok) {
      toast.success("Slack disconnected");
      onChange();
    }
  }

  const badge = status.workspaceSet ? (
    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 gap-1 font-mono text-[10px]">
      <Check className="size-3" /> {status.teamName ?? "Connected"}
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1 text-muted-foreground font-mono text-[10px]"
    >
      <X className="size-3" /> Not connected
    </Badge>
  );

  return (
    <SettingRow
      icon={<MessageSquare className="size-4" />}
      title="Slack bot token"
      hint={
        <>
          <span className="block">
            Lets agents post messages and ask teammates questions on Slack.
          </span>
          <span className="mt-1.5 block">
            <a
              href={SLACK_NEW_APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 hover:opacity-80"
            >
              Create a Slack app for WithVibe →
            </a>
          </span>
          <span className="mt-1.5 block">
            Then, in the Slack app settings page:
          </span>
          <span className="mt-1 block pl-3">
            1. Click{" "}
            <span className="font-mono text-foreground">OAuth &amp; Permissions</span>{" "}
            in the left sidebar.
          </span>
          <span className="mt-0.5 block pl-3">
            2. Click{" "}
            <span className="font-mono text-foreground">Install to Workspace</span>{" "}
            and approve the scopes Slack shows.
          </span>
          <span className="mt-0.5 block pl-3">
            3. Copy the{" "}
            <span className="font-mono text-foreground">Bot User OAuth Token</span>{" "}
            (starts with{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              xoxb-
            </code>
            ).
          </span>
          <span className="mt-0.5 block pl-3">
            4. Paste it below and click{" "}
            <span className="font-mono text-foreground">Connect</span>.
          </span>
          <span className="mt-1.5 block">
            The manifest pre-fills the bot scopes the agent needs:{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              chat:write
            </code>{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              chat:write.public
            </code>{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              im:write
            </code>{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              files:write
            </code>{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              users:read
            </code>{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              users:read.email
            </code>
            .
          </span>
          <span className="mt-1.5 block text-[11px] text-muted-foreground/80">
            Already created the app before <code className="font-mono">files:write</code> was added? Open OAuth &amp; Permissions, add the scope under{" "}
            <span className="font-mono text-foreground">
              Bot Token Scopes
            </span>
            , then click <span className="font-mono text-foreground">Reinstall to Workspace</span> at the top — the bot token stays the same.
          </span>
        </>
      }
      badge={badge}
    >
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">
          Admins only. The saved token is never shown again after it&apos;s set.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="slackBotToken" className="text-xs font-mono">
              {status.workspaceSet ? "Replace" : "Add token"}
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="slackBotToken"
                  type={reveal ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="xoxb-…"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono pr-9"
                />
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={reveal ? "Hide" : "Reveal"}
                >
                  {reveal ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
              <Button
                onClick={save}
                disabled={!value.trim() || saving}
                size="sm"
              >
                {saving ? "Saving…" : "Connect"}
              </Button>
            </div>
            {error && (
              <p className="text-xs text-destructive font-mono">{error}</p>
            )}
          </div>
          {status.workspaceSet && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive h-7 px-2 text-xs"
              onClick={disconnect}
              disabled={clearing}
            >
              {clearing ? "Removing…" : "Disconnect"}
            </Button>
          )}
        </>
      )}
    </SettingRow>
  );
}

function SlackAppTokenField({
  id,
  isAdmin,
  status,
  onChange,
}: {
  id: string;
  isAdmin: boolean;
  status: SlackStatus;
  onChange: () => void;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackAppToken: value.trim() || null }),
    });
    setSaving(false);
    if (res.ok) {
      setValue("");
      toast.success("Two-way Q&A enabled");
      onChange();
    } else {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      const msg = j.message || "Failed to save";
      setError(msg);
      toast.error(msg);
    }
  }

  async function disconnect() {
    if (
      !confirm(
        "Remove the app-level token? Two-way Q&A (slack_ask) will stop working; one-way slack_notify keeps working."
      )
    )
      return;
    setClearing(true);
    setError("");
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slackAppToken: null }),
    });
    setClearing(false);
    if (res.ok) {
      toast.success("App-level token removed");
      onChange();
    }
  }

  const botConnected = status.workspaceSet;
  const badge = status.twoWayEnabled ? (
    <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 gap-1 font-mono text-[10px]">
      <Check className="size-3" /> Two-way enabled
    </Badge>
  ) : (
    <Badge
      variant="outline"
      className="gap-1 text-muted-foreground font-mono text-[10px]"
    >
      <X className="size-3" /> Notify-only
    </Badge>
  );

  return (
    <SettingRow
      icon={<MessageSquare className="size-4" />}
      title="Slack app-level token (for two-way Q&A)"
      hint={
        <>
          <span className="block">
            Without this, the agent can only POST to Slack (
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              slack_notify
            </code>
            ). Add the app-level token to enable{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              slack_ask
            </code>
            : the agent posts a question, you reply in the Slack thread, and
            your answer comes back to the chat automatically.
          </span>
          <span className="mt-1.5 block">In the Slack app settings page:</span>
          <span className="mt-1 block pl-3">
            1. Click{" "}
            <span className="font-mono text-foreground">Basic Information</span>{" "}
            in the left sidebar.
          </span>
          <span className="mt-0.5 block pl-3">
            2. Scroll to{" "}
            <span className="font-mono text-foreground">App-Level Tokens</span>{" "}
            → click{" "}
            <span className="font-mono text-foreground">Generate Token</span>.
          </span>
          <span className="mt-0.5 block pl-3">
            3. Name it (e.g.{" "}
            <span className="font-mono text-foreground">withvibe</span>) and
            add the{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              connections:write
            </code>{" "}
            scope.
          </span>
          <span className="mt-0.5 block pl-3">
            4. Copy the token (starts with{" "}
            <code className="px-1 py-0.5 bg-muted rounded font-mono text-[11px]">
              xapp-
            </code>
            ) and paste it below.
          </span>
        </>
      }
      badge={badge}
    >
      {!botConnected ? (
        <p className="text-xs text-muted-foreground">
          Connect the Slack bot token first.
        </p>
      ) : !isAdmin ? (
        <p className="text-xs text-muted-foreground">
          Admins only. The saved token is never shown again after it&apos;s
          set.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="slackAppToken" className="text-xs font-mono">
              {status.appTokenSet ? "Replace" : "Add token"}
            </Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="slackAppToken"
                  type={reveal ? "text" : "password"}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="xapp-…"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono pr-9"
                />
                <button
                  type="button"
                  onClick={() => setReveal((r) => !r)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={reveal ? "Hide" : "Reveal"}
                >
                  {reveal ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}
                </button>
              </div>
              <Button
                onClick={save}
                disabled={!value.trim() || saving}
                size="sm"
              >
                {saving ? "Saving…" : "Connect"}
              </Button>
            </div>
            {error && (
              <p className="text-xs text-destructive font-mono">{error}</p>
            )}
          </div>
          {status.appTokenSet && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive h-7 px-2 text-xs"
              onClick={disconnect}
              disabled={clearing}
            >
              {clearing ? "Removing…" : "Disconnect"}
            </Button>
          )}
        </>
      )}
    </SettingRow>
  );
}

function DebugModeRow({
  id,
  isAdmin,
  value,
  onChange,
}: {
  id: string;
  isAdmin: boolean;
  value: boolean;
  onChange: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    setSaving(true);
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ debugMode: next }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success(next ? "Debug mode enabled" : "Debug mode disabled");
      onChange();
    } else {
      toast.error("Failed to save");
    }
  }

  return (
    <SettingRow
      icon={<Bug className="size-4 text-amber-400" />}
      title="Debug mode"
      hint="Shows live SDK events, per-turn timings, token usage, and tool-call traces inside the chat UI. Useful when a chat turn takes long and you want to see where the time is going. Applies to every teammate in this workspace."
      badge={
        value ? (
          <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 gap-1 font-mono text-[10px]">
            <Check className="size-3" /> On
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="gap-1 text-muted-foreground font-mono text-[10px]"
          >
            <X className="size-3" /> Off
          </Badge>
        )
      }
    >
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">Admins only.</p>
      ) : (
        <div>
          <Button
            variant={value ? "destructive" : "default"}
            size="sm"
            disabled={saving}
            onClick={() => toggle(!value)}
          >
            {saving
              ? "Saving…"
              : value
                ? "Turn off debug mode"
                : "Turn on debug mode"}
          </Button>
        </div>
      )}
    </SettingRow>
  );
}

function DefaultModelRow({
  id,
  isAdmin,
  value,
  onChange,
}: {
  id: string;
  isAdmin: boolean;
  value: ModelChoice;
  onChange: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function pick(next: ModelChoice) {
    if (next === value || saving) return;
    setSaving(true);
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultModel: next }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Default model updated");
      onChange();
    } else {
      toast.error("Failed to save");
    }
  }

  const current = MODEL_OPTIONS.find((o) => o.id === value) ?? MODEL_OPTIONS[0];

  return (
    <SettingRow
      icon={<Sparkles className="size-4" />}
      title="Default Claude model"
      hint="Used for chat in every env in this workspace, unless an env overrides it. Auto sends each turn through a small classifier that picks Opus / Sonnet / Haiku based on task complexity."
      badge={
        <Badge
          variant="outline"
          className="font-mono text-[10px] text-muted-foreground"
        >
          {current.label}
        </Badge>
      }
    >
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">Admins only.</p>
      ) : (
        <div className="space-y-2">
          {MODEL_OPTIONS.map((opt) => {
            const active = opt.id === value;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={saving}
                onClick={() => pick(opt.id)}
                className={[
                  "w-full text-left rounded-md border px-3 py-2 transition-smooth",
                  active
                    ? "bg-primary/10 border-primary/40"
                    : "bg-card hover:bg-muted/40 border-border/60",
                  saving && !active ? "opacity-50" : "",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold">
                    {opt.label}
                  </span>
                  {active && (
                    <Check className="size-3 text-primary" aria-hidden />
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {opt.description}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </SettingRow>
  );
}

const SANDBOX_OPTIONS: {
  key: string;
  val: boolean | null;
  label: string;
  description: string;
}[] = [
  {
    key: "inherit",
    val: null,
    label: "Inherit deployment default",
    description:
      "Use the IS_SANDBOX setting on the API server (default: on). Envs can still override this.",
  },
  {
    key: "on",
    val: true,
    label: "On — allow Bypass Permissions",
    description:
      "Claude Code may run in Bypass Permissions mode in this workspace's desktop/tunnel VS Code sessions, even though the API runs as root.",
  },
  {
    key: "off",
    val: false,
    label: "Off — permission prompts",
    description:
      "Claude runs with normal permission prompts in tunnel VS Code; Bypass Permissions mode is unavailable for this workspace.",
  },
];

function SandboxBypassRow({
  id,
  isAdmin,
  value,
  onChange,
}: {
  id: string;
  isAdmin: boolean;
  value: boolean | null;
  onChange: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function pick(next: boolean | null) {
    if (next === value || saving) return;
    setSaving(true);
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxBypass: next }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Bypass Permissions policy updated");
      onChange();
    } else {
      toast.error("Failed to save");
    }
  }

  const current =
    SANDBOX_OPTIONS.find((o) => o.val === value) ?? SANDBOX_OPTIONS[0];

  return (
    <SettingRow
      icon={<ShieldAlert className="size-4 text-amber-400" />}
      title="Claude Bypass Permissions (tunnel VS Code)"
      hint="Controls whether Claude Code may auto-approve actions (Bypass Permissions mode) in the desktop/tunnel VS Code path. The API runs as root, so this needs the IS_SANDBOX escape hatch. Envs can override this per-env."
      badge={
        <Badge
          variant="outline"
          className="font-mono text-[10px] text-muted-foreground"
        >
          {current.label}
        </Badge>
      }
    >
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">Admins only.</p>
      ) : (
        <div className="space-y-2">
          {SANDBOX_OPTIONS.map((opt) => {
            const active = opt.val === value;
            return (
              <button
                key={opt.key}
                type="button"
                disabled={saving}
                onClick={() => pick(opt.val)}
                className={[
                  "w-full text-left rounded-md border px-3 py-2 transition-smooth",
                  active
                    ? "bg-primary/10 border-primary/40"
                    : "bg-card hover:bg-muted/40 border-border/60",
                  saving && !active ? "opacity-50" : "",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-semibold">
                    {opt.label}
                  </span>
                  {active && (
                    <Check className="size-3 text-primary" aria-hidden />
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {opt.description}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </SettingRow>
  );
}

function DirectMergeRow({
  id,
  isAdmin,
  value,
  onChange,
}: {
  id: string;
  isAdmin: boolean;
  value: boolean;
  onChange: () => void;
}) {
  const [saving, setSaving] = useState(false);

  async function toggle(next: boolean) {
    setSaving(true);
    const res = await fetch(`/api/workspaces/${id}/settings/integrations`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowDirectMerge: next }),
    });
    setSaving(false);
    if (res.ok) {
      toast.success(next ? "Direct merge enabled" : "Direct merge disabled");
      onChange();
    } else {
      toast.error("Failed to save");
    }
  }

  return (
    <SettingRow
      icon={<AlertTriangle className="size-4 text-amber-400" />}
      title="Direct merge to base"
      hint="Lets members merge an env branch straight into the base branch on GitHub without opening a pull request. Skips review — use this only on solo or fully-trusted projects."
      badge={
        value ? (
          <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/20 gap-1 font-mono text-[10px]">
            <Check className="size-3" /> Enabled
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="gap-1 text-muted-foreground font-mono text-[10px]"
          >
            <X className="size-3" /> Disabled
          </Badge>
        )
      }
    >
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">Admins only.</p>
      ) : (
        <div>
          <Button
            variant={value ? "destructive" : "default"}
            size="sm"
            disabled={saving}
            onClick={() => toggle(!value)}
          >
            {saving
              ? "Saving…"
              : value
                ? "Disable direct merge"
                : "Enable direct merge"}
          </Button>
        </div>
      )}
    </SettingRow>
  );
}

type SecretRow = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

function SecretsManager({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const [rows, setRows] = useState<SecretRow[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${id}/settings/secrets`);
    if (!res.ok) {
      setError("Failed to load secrets");
      setRows([]);
      return;
    }
    const data = (await res.json()) as SecretRow[];
    setRows(Array.isArray(data) ? data : []);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function createSecret() {
    const name = newName.trim();
    if (!name || !newValue) return;
    setBusy(true);
    const res = await fetch(`/api/workspaces/${id}/settings/secrets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, value: newValue }),
    });
    setBusy(false);
    if (res.ok) {
      toast.success(`Saved "${name}"`);
      setNewName("");
      setNewValue("");
      setAdding(false);
      void load();
    } else {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      toast.error(j.message || "Failed to save");
    }
  }

  async function updateSecret(name: string) {
    setBusy(true);
    const res = await fetch(
      `/api/workspaces/${id}/settings/secrets/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: editValue }),
      }
    );
    setBusy(false);
    if (res.ok) {
      toast.success(`Updated "${name}"`);
      setEditing(null);
      setEditValue("");
      void load();
    } else {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      toast.error(j.message || "Failed to update");
    }
  }

  async function deleteSecret(name: string) {
    if (!confirm(`Delete secret "${name}"? Templates referencing it will fall back to the API process env.`)) {
      return;
    }
    setBusy(true);
    const res = await fetch(
      `/api/workspaces/${id}/settings/secrets/${encodeURIComponent(name)}`,
      { method: "DELETE" }
    );
    setBusy(false);
    if (res.ok) {
      toast.success(`Deleted "${name}"`);
      void load();
    } else {
      toast.error("Failed to delete");
    }
  }

  if (rows === null) {
    return (
      <p className="text-xs text-muted-foreground italic">Loading secrets…</p>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No workspace secrets yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => (
            <li
              key={s.id}
              className="rounded-md border p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <code className="font-mono text-sm">{s.name}</code>
                {isAdmin && (
                  <div className="flex items-center gap-2">
                    {editing === s.name ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditing(null);
                            setEditValue("");
                          }}
                          disabled={busy}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void updateSecret(s.name)}
                          disabled={busy || !editValue}
                        >
                          {busy ? "Saving…" : "Save"}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditing(s.name);
                            setEditValue("");
                          }}
                        >
                          Rotate value
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => void deleteSecret(s.name)}
                          aria-label={`Delete ${s.name}`}
                          disabled={busy}
                        >
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {editing === s.name && (
                <Input
                  type="password"
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder="New value (replaces the existing one)"
                  className="font-mono text-xs"
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {!isAdmin ? null : adding ? (
        <div className="rounded-md border p-3 space-y-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value.toUpperCase())}
                placeholder="OPENAI_API_KEY"
                className="font-mono"
              />
              <p className="text-[10px] text-muted-foreground">
                UPPER_SNAKE_CASE. Templates reference this via{" "}
                <code className="font-mono">secretName</code> on a variable.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Value</Label>
              <Input
                type="password"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="sk-…"
                className="font-mono text-xs"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setAdding(false);
                setNewName("");
                setNewValue("");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void createSecret()}
              disabled={busy || !newName.trim() || !newValue}
            >
              {busy ? "Saving…" : "Save secret"}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-4" /> Add secret
        </Button>
      )}
    </div>
  );
}

type StorageConfig = {
  mode: "LOCAL" | "S3";
  localPath: string | null;
  s3: {
    bucket: string | null;
    region: string | null;
    prefix: string | null;
    accessKeyIdSet: boolean;
    secretAccessKeySet: boolean;
  };
};

function StorageSection({ id, isAdmin }: { id: string; isAdmin: boolean }) {
  const [data, setData] = useState<StorageConfig | null>(null);
  const [mode, setMode] = useState<"LOCAL" | "S3">("LOCAL");
  const [localPath, setLocalPath] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [prefix, setPrefix] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    | { ok: true; target: string }
    | { ok: false; target?: string; error: string }
    | null
  >(null);
  const [migrating, setMigrating] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${id}/settings/storage`);
    if (!res.ok) return;
    const j = (await res.json()) as StorageConfig;
    setData(j);
    setMode(j.mode);
    setLocalPath(j.localPath ?? "");
    setBucket(j.s3.bucket ?? "");
    setRegion(j.s3.region ?? "");
    setPrefix(j.s3.prefix ?? "");
    setAccessKeyId("");
    setSecretAccessKey("");
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setSaving(true);
    setTestResult(null);
    const body: Record<string, unknown> = {
      mode,
      localPath: localPath.trim() || null,
      s3Bucket: bucket.trim() || null,
      s3Region: region.trim() || null,
      s3Prefix: prefix.trim() || null,
    };
    // Only send credentials if the user typed something — empty input means
    // "leave the existing value alone." Use the Disconnect buttons to clear.
    if (accessKeyId.trim()) body.s3AccessKeyId = accessKeyId.trim();
    if (secretAccessKey.trim()) body.s3SecretAccessKey = secretAccessKey.trim();

    const res = await fetch(`/api/workspaces/${id}/settings/storage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (res.ok) {
      toast.success("Storage settings saved");
      void load();
    } else {
      toast.error("Failed to save");
    }
  }

  async function clearS3Credentials() {
    if (!confirm("Remove saved S3 credentials from this workspace?")) return;
    const res = await fetch(`/api/workspaces/${id}/settings/storage`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        s3AccessKeyId: null,
        s3SecretAccessKey: null,
      }),
    });
    if (res.ok) {
      toast.success("S3 credentials cleared");
      void load();
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    const res = await fetch(`/api/workspaces/${id}/settings/storage/test`, {
      method: "POST",
    });
    setTesting(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      setTestResult({ ok: false, error: j.message || "Request failed" });
      return;
    }
    const j = (await res.json()) as
      | { ok: true; target: string }
      | { ok: false; target?: string; error: string };
    setTestResult(j);
    if (j.ok) toast.success("Storage connection ok");
    else toast.error("Storage test failed");
  }

  if (data === null) {
    return (
      <p className="text-xs text-muted-foreground italic p-4">Loading…</p>
    );
  }

  const dirty =
    mode !== data.mode ||
    localPath !== (data.localPath ?? "") ||
    bucket !== (data.s3.bucket ?? "") ||
    region !== (data.s3.region ?? "") ||
    prefix !== (data.s3.prefix ?? "") ||
    accessKeyId.trim().length > 0 ||
    secretAccessKey.trim().length > 0;

  return (
    <SettingRow
      icon={<Database className="size-4" />}
      title="Storage backend"
      hint="Compose files and uploaded assets are written here. Local mode uses a directory on the API host; S3 stores them in a bucket with optional key prefix."
      badge={
        <Badge
          variant="outline"
          className="gap-1 font-mono text-[10px] text-muted-foreground"
        >
          {data.mode}
        </Badge>
      }
    >
      {!isAdmin ? (
        <p className="text-xs text-muted-foreground">Admins only.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={mode === "LOCAL" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("LOCAL")}
            >
              Local disk
            </Button>
            <Button
              type="button"
              variant={mode === "S3" ? "default" : "outline"}
              size="sm"
              onClick={() => setMode("S3")}
            >
              S3
            </Button>
          </div>

          {mode === "LOCAL" ? (
            <div className="space-y-1.5">
              <Label htmlFor="storage-local-path" className="text-xs font-mono">
                Base path on API host
              </Label>
              <Input
                id="storage-local-path"
                value={localPath}
                onChange={(e) => setLocalPath(e.target.value)}
                placeholder="/var/lib/withvibe/workspaces/<id>"
                className="font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground">
                Must be writable by the API process. Created automatically on
                first write.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="storage-s3-bucket" className="text-xs font-mono">
                    Bucket
                  </Label>
                  <Input
                    id="storage-s3-bucket"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="my-team-withvibe"
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="storage-s3-region" className="text-xs font-mono">
                    Region
                  </Label>
                  <Input
                    id="storage-s3-region"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="us-east-1"
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="storage-s3-prefix" className="text-xs font-mono">
                  Key prefix (optional)
                </Label>
                <Input
                  id="storage-s3-prefix"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="workspaces/<id>/"
                  className="font-mono text-xs"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="storage-s3-access-key" className="text-xs font-mono">
                    Access key ID
                    {data.s3.accessKeyIdSet && (
                      <span className="ml-2 text-emerald-400 font-normal">saved</span>
                    )}
                  </Label>
                  <Input
                    id="storage-s3-access-key"
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                    placeholder={data.s3.accessKeyIdSet ? "(leave blank to keep)" : "AKIA…"}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="storage-s3-secret" className="text-xs font-mono">
                    Secret access key
                    {data.s3.secretAccessKeySet && (
                      <span className="ml-2 text-emerald-400 font-normal">saved</span>
                    )}
                  </Label>
                  <Input
                    id="storage-s3-secret"
                    type="password"
                    value={secretAccessKey}
                    onChange={(e) => setSecretAccessKey(e.target.value)}
                    placeholder={
                      data.s3.secretAccessKeySet ? "(leave blank to keep)" : "••••"
                    }
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-xs"
                  />
                </div>
              </div>
              {(data.s3.accessKeyIdSet || data.s3.secretAccessKeySet) && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive h-7 px-2 text-xs"
                  onClick={clearS3Credentials}
                >
                  Disconnect S3 credentials
                </Button>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} disabled={!dirty || saving} size="sm">
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={test}
              disabled={testing || dirty}
              title={dirty ? "Save changes first" : undefined}
            >
              {testing ? "Testing…" : "Test connection"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={migrating || dirty}
              title={
                dirty
                  ? "Save changes first"
                  : "Copy existing envs' compose + assets into the configured storage backend."
              }
              onClick={async () => {
                if (
                  !confirm(
                    "Copy compose + assets for every active env in this workspace into the current storage backend? Idempotent — safe to re-run."
                  )
                )
                  return;
                setMigrating(true);
                const res = await fetch(
                  `/api/workspaces/${id}/settings/storage/migrate`,
                  { method: "POST" }
                );
                setMigrating(false);
                if (!res.ok) {
                  toast.error("Migration failed");
                  return;
                }
                const j = (await res.json()) as {
                  envs: { envId: string; copied: number; skipped: number; errors: string[] }[];
                };
                const copied = j.envs.reduce((s, e) => s + e.copied, 0);
                const errs = j.envs.reduce((s, e) => s + e.errors.length, 0);
                if (errs > 0) {
                  toast.warning(
                    `Migrated ${copied} file(s) across ${j.envs.length} env(s) — ${errs} error(s); see server logs`
                  );
                } else {
                  toast.success(
                    `Migrated ${copied} file(s) across ${j.envs.length} env(s)`
                  );
                }
              }}
            >
              {migrating ? "Migrating…" : "Migrate existing envs"}
            </Button>
          </div>

          {testResult && (
            <div
              className={`rounded-md border p-3 text-xs font-mono ${
                testResult.ok
                  ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300"
                  : "border-destructive/30 bg-destructive/5 text-destructive"
              }`}
            >
              {testResult.ok ? (
                <span>
                  <Check className="inline size-3 mr-1" />
                  Round-trip ok at <span className="text-foreground">{testResult.target}</span>
                </span>
              ) : (
                <span>
                  <X className="inline size-3 mr-1" />
                  {testResult.error}
                  {testResult.target && (
                    <span className="block opacity-70 mt-1">
                      Target: {testResult.target}
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </SettingRow>
  );
}

