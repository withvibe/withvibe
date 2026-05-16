"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Mail, Pencil, RefreshCw } from "lucide-react";
import { positionLabel, MAX_BIO_LENGTH } from "@withvibe/db/profile-constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PositionSelect } from "@/components/profile/position-select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";

type Member = {
  id: string;
  role: "admin" | "member";
  user: {
    id: string;
    email: string;
    name: string | null;
    positions: string[];
    bio: string | null;
  };
  isMe: boolean;
};

export default function TeamPage(props: PageProps<"/workspaces/[id]/team">) {
  const { id } = use(props.params);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);
  const [positions, setPositions] = useState<string[]>([]);
  const [bio, setBio] = useState("");
  const [saving, setSaving] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/workspaces/${id}/members`);
    if (res.ok) setMembers(await res.json());
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const me = useMemo(() => members?.find((m) => m.isMe), [members]);
  const isAdmin = me?.role === "admin";

  function openEdit(m: Member) {
    setEditing(m);
    setPositions(m.user.positions || []);
    setBio(m.user.bio || "");
  }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    const res = await fetch(`/api/account`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions, bio }),
    });
    setSaving(false);
    if (res.ok) {
      setEditing(null);
      toast.success("Your info was updated");
      load();
    } else {
      toast.error("Failed to save");
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 sm:p-8 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-mono font-bold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Everyone in this workspace. Names, positions, and bios become part
            of the AI&apos;s context when you chat.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setInviteOpen(true)} className="shrink-0">
            <Mail className="size-4" />
            Invite member
          </Button>
        )}
      </div>

      {members === null ? (
        <Skeleton className="h-48 rounded-md" />
      ) : (
        <Card className="p-0 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-border/60">
                <TableHead className="w-[28%]">Member</TableHead>
                <TableHead className="w-[10%]">Role</TableHead>
                <TableHead className="w-[22%]">Position</TableHead>
                <TableHead>About</TableHead>
                <TableHead className="w-[6%]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => {
                const posLabels = m.user.positions.map(positionLabel);
                return (
                  <TableRow key={m.id} className="border-border/60">
                    <TableCell>
                      <div className="flex items-center gap-3 min-w-0">
                        <Avatar className="rounded-md">
                          <AvatarFallback className="rounded-md bg-primary/10 text-primary text-xs font-mono font-bold border border-primary/20">
                            {(m.user.name || m.user.email)
                              .slice(0, 2)
                              .toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate">
                              {m.user.name || m.user.email}
                            </span>
                            {m.isMe && (
                              <Badge
                                variant="secondary"
                                className="text-[10px] px-1.5 font-mono"
                              >
                                you
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            {m.user.email}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {m.role === "admin" ? (
                        <Badge className="bg-primary/10 text-primary border-primary/20 font-mono">
                          admin
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="font-mono">
                          member
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {posLabels.length === 0 ? (
                        <span className="text-muted-foreground/50 italic">
                          —
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {posLabels.map((l) => (
                            <span
                              key={l}
                              className="text-[10px] font-mono rounded px-1.5 py-0.5 bg-muted/40 border border-border/50"
                            >
                              {l}
                            </span>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.user.bio ? (
                        <span className="line-clamp-2">{m.user.bio}</span>
                      ) : (
                        <span className="text-muted-foreground/50 italic">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {m.isMe && (
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Edit your info"
                          onClick={() => openEdit(m)}
                        >
                          <Pencil className="size-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your info</DialogTitle>
            <DialogDescription>
              Shown across every workspace. Helps the AI tailor answers to you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        workspaceId={id}
      />
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
}) {
  const [role, setRole] = useState<"member" | "admin">("member");
  const [generating, setGenerating] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setRole("member");
      setUrl(null);
      setCopied(false);
    }
  }, [open]);

  async function generate() {
    setGenerating(true);
    setCopied(false);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/invitations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        }
      );
      if (!res.ok) {
        toast.error("Failed to generate invite");
        return;
      }
      const data = await res.json();
      setUrl(`${window.location.origin}/invite/${data.token}`);
    } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Invite link copied");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono">
            <Mail className="size-4" />
            Invite a teammate
          </DialogTitle>
          <DialogDescription>
            Generate a shareable link. Anyone with the link can join this
            workspace. Link expires in 7 days.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as "member" | "admin")}
              disabled={url !== null}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">
                  <div className="flex flex-col items-start">
                    <span>Member</span>
                    <span className="text-xs text-muted-foreground">
                      Can chat, create environments, edit their own info
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="admin">
                  <div className="flex flex-col items-start">
                    <span>Admin</span>
                    <span className="text-xs text-muted-foreground">
                      Plus: manage repos, invite members, workspace settings
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {url && (
            <div className="space-y-2">
              <Label className="text-xs">Shareable link</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={url}
                  className="font-mono text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button onClick={copy}>
                  {copied ? (
                    <>
                      <Check className="size-4" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="size-4" /> Copy
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {url ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
              <Button variant="outline" onClick={generate} disabled={generating}>
                <RefreshCw className="size-4" />
                New link
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={generate} disabled={generating}>
                {generating ? "Generating…" : "Generate link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
