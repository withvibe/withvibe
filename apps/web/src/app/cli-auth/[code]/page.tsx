import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { getCurrentUser } from "@/lib/auth";
import { ConfirmCliAuthButton } from "./confirm-button";

type PageProps = {
  params: Promise<{ code: string }>;
};

type CodeInfo = { label: string | null; expiresAt: string };

export default async function CliAuthPage({ params }: PageProps) {
  const { code } = await params;

  const user = await getCurrentUser();
  if (!user) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/cli-auth/${code}`)}`);
  }

  const res = await apiFetch(`/cli-auth/code/${encodeURIComponent(code)}`, {
    cache: "no-store",
  });

  const isMissing = res.status === 404;
  const isExpired = res.status === 410;
  const isUsed = res.status === 409;
  const info: CodeInfo | null = res.ok ? ((await res.json()) as CodeInfo) : null;

  return (
    <div className="mx-auto mt-24 max-w-md rounded-lg border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
      <h1 className="text-xl font-semibold">Authorize CLI device</h1>

      {isMissing && (
        <p className="mt-4 text-sm text-red-600">
          This code is not valid. Re-run <code>withvibe login</code> in your
          terminal.
        </p>
      )}

      {isExpired && (
        <p className="mt-4 text-sm text-red-600">
          This code has expired. Re-run <code>withvibe login</code> to get a
          fresh one.
        </p>
      )}

      {isUsed && (
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-300">
          This code was already approved. You can close this tab.
        </p>
      )}

      {info && (
        <>
          <p className="mt-4 text-sm text-neutral-700 dark:text-neutral-300">
            A CLI on <strong>{info.label || "an unknown device"}</strong> is
            requesting access to your workspaces. Approve only if you started
            this login.
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            Signed in as {user.email}
          </p>
          <div className="mt-6">
            <ConfirmCliAuthButton code={code} />
          </div>
        </>
      )}
    </div>
  );
}
