"use client";

import { logout, useUser } from "@/lib/auth-client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Brand } from "@/components/brand";
import { toast } from "sonner";
import { MAX_BIO_LENGTH } from "@withvibe/db/profile-constants";
import { PositionSelect } from "@/components/profile/position-select";

type Account = {
  id: string;
  email: string;
  name: string | null;
  positions: string[];
  bio: string | null;
};

export default function AccountPage() {
  const { status } = useUser();
  const router = useRouter();
  const [account, setAccount] = useState<Account | null>(null);
  const [name, setName] = useState("");
  const [positions, setPositions] = useState<string[]>([]);
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((a: Account | null) => {
        if (a) {
          setAccount(a);
          setName(a.name || "");
          setPositions(a.positions || []);
          setBio(a.bio || "");
        }
      });
  }, [status]);

  async function save() {
    setSaving(true);
    const res = await fetch("/api/account", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, positions, bio }),
    });
    setSaving(false);
    if (res.ok) {
      const updated = await res.json();
      setAccount(updated);
      toast.success("Account updated");
    } else {
      toast.error("Failed to save");
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between px-6 sm:px-10 h-16 border-b border-border/60">
        <Link href="/">
          <Brand />
        </Link>
        <Button variant="ghost" size="sm" render={<Link href="/" />}>
          <ArrowLeft className="size-4" />
          Workspaces
        </Button>
      </header>

      <main className="max-w-xl mx-auto px-4 py-10 space-y-6">
        <div>
          <h1 className="text-xl font-mono font-bold tracking-tight">Account</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your global profile — used across every workspace you belong to.
          </p>
        </div>

        {account === null ? (
          <Skeleton className="h-48 rounded-md" />
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="font-mono text-base">
                  Personal info
                </CardTitle>
                <CardDescription>
                  How you appear to teammates across workspaces.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    value={account.email}
                    readOnly
                    className="bg-muted/40"
                  />
                  <p className="text-xs text-muted-foreground">
                    Email is used for sign-in. Changing it is not supported yet.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="name">Display name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                  />
                </div>
                <PositionSelect
                  positions={positions}
                  onPositionsChange={setPositions}
                />
                <div className="space-y-2">
                  <Label htmlFor="bio">Tell us about yourself</Label>
                  <Textarea
                    id="bio"
                    rows={4}
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="What you work on, what you're good at, anything the AI should know."
                    maxLength={MAX_BIO_LENGTH}
                  />
                  <p className="text-xs text-muted-foreground text-right">
                    {bio.length} / {MAX_BIO_LENGTH}
                  </p>
                </div>
                <div className="flex justify-end">
                  <Button onClick={save} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="font-mono text-base">Session</CardTitle>
              </CardHeader>
              <CardContent>
                <Button
                  variant="outline"
                  onClick={async () => {
                    await logout();
                    router.push("/login");
                  }}
                >
                  <LogOut className="size-4" />
                  Sign out
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
