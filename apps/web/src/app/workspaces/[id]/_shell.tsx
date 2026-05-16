"use client";

import { logout } from "@/lib/auth-client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Bot,
  ChevronsUpDown,
  Cog,
  GitBranch,
  Inbox,
  ListChecks,
  LogOut,
  Plus,
  Star,
  UserRound,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Brand } from "@/components/brand";
import { ActiveRunsProvider } from "./_active-runs";

export function WorkspaceShell({
  version,
  workspace,
  role,
  user,
  workspaces,
  defaultWorkspaceId,
  integrations,
  children,
}: {
  version: string;
  workspace: { id: string; name: string };
  role: "admin" | "member";
  user: { name: string | null; email: string };
  workspaces: { id: string; name: string }[];
  defaultWorkspaceId: string | null;
  integrations: { anthropic: boolean; github: boolean };
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [defaultId, setDefaultId] = useState<string | null>(defaultWorkspaceId);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inboxPending, setInboxPending] = useState(0);

  const initials = (user.name || user.email).slice(0, 2).toUpperCase();
  const settingsWarn = !integrations.anthropic;

  useEffect(() => {
    let cancelled = false;
    const fetchCount = () => {
      fetch(`/api/workspaces/${workspace.id}/inbox/count`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d) setInboxPending(d.pending ?? 0);
        })
        .catch(() => {});
    };
    fetchCount();
    const t = setInterval(fetchCount, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [workspace.id]);

  async function setDefault(wsId: string) {
    const prev = defaultId;
    setDefaultId(wsId);
    const res = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultWorkspaceId: wsId }),
    });
    if (res.ok) {
      toast.success("Default workspace updated");
      router.refresh();
    } else {
      setDefaultId(prev);
      toast.error("Failed to set default");
    }
  }

  return (
    <ActiveRunsProvider workspaceId={workspace.id}>
    <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-1 py-1 overflow-hidden group-data-[collapsible=icon]:hidden">
            <Brand className="text-sm" />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
              <div className="flex aspect-square size-7 items-center justify-center rounded-md bg-primary/10 text-primary text-xs font-mono font-bold border border-primary/20">
                {workspace.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-mono font-medium">
                  {workspace.name}
                </span>
                <span className="truncate text-xs text-muted-foreground capitalize">
                  {role}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="min-w-56" align="start" side="bottom">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-xs text-muted-foreground">
                  Workspaces
                </DropdownMenuLabel>
                {workspaces.map((w) => {
                  const isDefault = defaultId === w.id;
                  return (
                    <DropdownMenuItem
                      key={w.id}
                      onClick={() => router.push(`/workspaces/${w.id}`)}
                      className="gap-2"
                    >
                      <div className="flex size-5 items-center justify-center rounded bg-primary/10 text-primary text-[10px] font-mono font-bold border border-primary/20">
                        {w.name.slice(0, 1).toUpperCase()}
                      </div>
                      <span className="font-mono flex-1">{w.name}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!isDefault) setDefault(w.id);
                        }}
                        title={
                          isDefault
                            ? "Default workspace"
                            : "Set as default"
                        }
                        className={cn(
                          "p-1 rounded hover:bg-sidebar-accent transition-smooth",
                          isDefault ? "text-yellow-400" : "text-muted-foreground/60 hover:text-foreground"
                        )}
                      >
                        <Star
                          className={cn(
                            "size-3.5",
                            isDefault && "fill-current"
                          )}
                        />
                      </button>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => router.push("/workspaces/new")}>
                <Plus className="size-4" />
                New workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Navigation</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link href={`/workspaces/${workspace.id}`} />}
                    isActive={
                      pathname === `/workspaces/${workspace.id}` ||
                      pathname.startsWith(
                        `/workspaces/${workspace.id}/environments`
                      )
                    }
                  >
                    <ListChecks />
                    <span>Environments</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={<Link href={`/workspaces/${workspace.id}/team`} />}
                    isActive={pathname === `/workspaces/${workspace.id}/team`}
                  >
                    <Users />
                    <span>Team</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={
                      <Link
                        href={`/workspaces/${workspace.id}/settings/repos`}
                      />
                    }
                    isActive={
                      pathname === `/workspaces/${workspace.id}/settings/repos`
                    }
                  >
                    <GitBranch />
                    <span>Repositories</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={
                      <Link
                        href={`/workspaces/${workspace.id}/settings/agents`}
                      />
                    }
                    isActive={
                      pathname ===
                      `/workspaces/${workspace.id}/settings/agents`
                    }
                  >
                    <Bot />
                    <span>Agents</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={
                      <Link href={`/workspaces/${workspace.id}/inbox`} />
                    }
                    isActive={
                      pathname === `/workspaces/${workspace.id}/inbox`
                    }
                  >
                    <Inbox />
                    <span className="flex-1">Inbox</span>
                    {inboxPending > 0 && (
                      <span className="ml-auto inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-mono min-w-5 h-5 px-1.5">
                        {inboxPending > 99 ? "99+" : inboxPending}
                      </span>
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    render={
                      <Link href={`/workspaces/${workspace.id}/settings`} />
                    }
                    isActive={pathname === `/workspaces/${workspace.id}/settings`}
                  >
                    <Cog />
                    <span className="flex-1">Settings</span>
                    {settingsWarn && (
                      <span
                        className="size-1.5 rounded-full bg-yellow-400"
                        title="API key not configured"
                      />
                    )}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger render={<SidebarMenuButton size="lg" />}>
                  <Avatar className="size-8 rounded-md">
                    <AvatarFallback className="rounded-md bg-primary/10 text-primary text-xs font-mono font-bold border border-primary/20">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">
                      {user.name || user.email}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {user.email}
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="end"
                  className="min-w-56"
                >
                  <DropdownMenuItem onClick={() => router.push("/account")}>
                    <UserRound className="size-4" />
                    Account
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={async () => {
                      await logout();
                      router.push("/login");
                    }}
                  >
                    <LogOut className="size-4" />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="px-2 pb-1 text-[10px] text-muted-foreground/70 text-center group-data-[collapsible=icon]:hidden">
            WithVibe v{version}
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-w-0 overflow-hidden">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-4">
          <SidebarTrigger
            className="size-8 hover:bg-accent"
            title="Toggle sidebar (⌘B)"
          />
          <Breadcrumbs
            workspaceId={workspace.id}
            workspaceName={workspace.name}
          />
        </header>
        <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
    </ActiveRunsProvider>
  );
}

function Breadcrumbs({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const rest = segments.slice(2);

  const label: { href: string; text: string }[] = [
    { href: `/workspaces/${workspaceId}`, text: workspaceName },
  ];

  if (rest[0] === "environments" && rest[1] === "new") {
    label.push({ href: pathname, text: "New environment" });
  } else if (rest[0] === "environments" && rest[1]) {
    label.push({ href: pathname, text: "Environment" });
  } else if (rest[0] === "team") {
    label.push({ href: pathname, text: "Team" });
  } else if (rest[0] === "settings" && rest[1] === "repos") {
    label.push({ href: pathname, text: "Repositories" });
  } else if (rest[0] === "settings" && !rest[1]) {
    label.push({ href: pathname, text: "Settings" });
  }

  return (
    <nav className="flex items-center gap-1.5 text-sm font-mono">
      {label.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-muted-foreground">/</span>}
          {i === label.length - 1 ? (
            <span className="font-medium">{item.text}</span>
          ) : (
            <Link
              href={item.href}
              className="text-muted-foreground hover:text-foreground"
            >
              {item.text}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
