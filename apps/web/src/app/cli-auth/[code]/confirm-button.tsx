"use client";

import { useState } from "react";

export function ConfirmCliAuthButton({ code }: { code: string }) {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle"
  );
  const [error, setError] = useState<string | null>(null);

  async function approve() {
    setStatus("loading");
    setError(null);
    const res = await fetch("/api/cli-auth/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      setStatus("done");
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error || `Request failed (${res.status})`);
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <p className="text-sm text-green-600">
        Approved. You can close this tab and return to your terminal.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <button
        onClick={approve}
        disabled={status === "loading"}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
      >
        {status === "loading" ? "Approving…" : "Approve CLI device"}
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
