"use client";

import { logout, useUser } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Brand } from "@/components/brand";

type InviteInfo = {
  workspace: { id: string; name: string; description: string | null };
  role: "admin" | "member";
  email: string | null;
  invitedBy: { name: string | null; email: string } | null;
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="flex items-center justify-between px-6 sm:px-10 h-16 border-b border-border/60">
        <Link href="/">
          <Brand />
        </Link>
      </header>
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}

export default function AcceptInvitePage(
  props: PageProps<"/invite/[token]">
) {
  const { token } = use(props.params);
  const { user: session, status } = useUser();
  const router = useRouter();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [alreadyMemberWorkspaceId, setAlreadyMemberWorkspaceId] = useState<
    string | null
  >(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/invitations/${token}`).then(async (r) => {
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.error || "Invitation invalid");
        return;
      }
      setInfo(await r.json());
    });
  }, [token]);

  async function accept() {
    setSubmitting(true);
    setError(null);

    const res = await fetch(`/api/invitations/${token}/accept`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (res.status === 409) {
      const data = await res.json();
      setAlreadyMemberWorkspaceId(data.workspaceId);
      setSubmitting(false);
      return;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Failed to accept invitation");
      setSubmitting(false);
      return;
    }

    const { workspaceId } = await res.json();
    router.push(`/workspaces/${workspaceId}`);
  }

  if (error) {
    return (
      <Shell>
        <Card>
          <CardHeader className="text-center">
            <CardTitle>Invitation unavailable</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button variant="outline" render={<Link href="/login" />}>
              Go to sign in
            </Button>
          </CardFooter>
        </Card>
      </Shell>
    );
  }

  if (alreadyMemberWorkspaceId) {
    return (
      <Shell>
        <Card>
          <CardHeader className="text-center">
            <CardTitle>You&apos;re already in</CardTitle>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button
              render={<Link href={`/workspaces/${alreadyMemberWorkspaceId}`} />}
            >
              Go to workspace
            </Button>
          </CardFooter>
        </Card>
      </Shell>
    );
  }

  if (!info || status === "loading") {
    return (
      <Shell>
        <div className="text-center text-sm text-muted-foreground">
          Loading invitation…
        </div>
      </Shell>
    );
  }

  if (status === "unauthenticated") {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>You&apos;re invited to {info.workspace.name}</CardTitle>
            <CardDescription>
              {info.invitedBy?.name || info.invitedBy?.email || "A teammate"}{" "}
              invited you as <Badge variant="secondary">{info.role}</Badge>
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex-col gap-2">
            <Button
              className="w-full"
              render={<Link href={`/login?invite=${token}`} />}
            >
              Sign in to join
            </Button>
            <Button
              variant="outline"
              className="w-full"
              render={<Link href={`/register?invite=${token}`} />}
            >
              Create an account
            </Button>
          </CardFooter>
        </Card>
      </Shell>
    );
  }

  const currentEmail = session?.email;

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>Join {info.workspace.name}</CardTitle>
          <CardDescription className="space-y-1">
            <span className="block">
              {info.invitedBy?.name || info.invitedBy?.email || "A teammate"}{" "}
              invited you as <Badge variant="secondary">{info.role}</Badge>
            </span>
            {info.workspace.description && (
              <span className="block text-muted-foreground">
                {info.workspace.description}
              </span>
            )}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {currentEmail && (
            <Alert>
              <AlertDescription className="flex items-center justify-between gap-3">
                <span className="text-xs">
                  Signed in as{" "}
                  <span className="font-mono font-medium text-foreground">
                    {currentEmail}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    await logout();
                    router.push(`/invite/${token}`);
                  }}
                  className="text-xs text-primary hover:underline shrink-0"
                >
                  Not you? Sign out
                </button>
              </AlertDescription>
            </Alert>
          )}

          <Button
            onClick={accept}
            className="w-full"
            disabled={submitting}
          >
            {submitting ? "Joining…" : "Join workspace"}
          </Button>
        </CardContent>
      </Card>
    </Shell>
  );
}
