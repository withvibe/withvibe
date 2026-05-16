// Thin wrapper around the web app's HTTP endpoints used by the CLI.
// The server URL always points at the Next.js web app (not the Nest API) —
// web is the auth edge and mints the internal JWT to call Nest.

export type InitiateResponse = {
  code: string;
  expiresAt: string;
};

export type PollResponse =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "confirmed"; token: string };

export type LocalBundleResponse = {
  env: {
    id: string;
    title: string;
    description: string | null;
    workspaceId: string;
    mode: "hosted" | "local";
  };
  repos: { name: string; url: string; branch: string }[];
  bundle:
    | {
        kind: "template";
        composeFile: string;
        resolvedVars: Record<string, string>;
        portKeys: string[];
        assets: { path: string; content: string; isTemplate: boolean }[];
      }
    | { kind: "custom"; composeFile: string }
    | { kind: "none" };
};

async function request<T>(
  server: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const url = `${server.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${init.method || "GET"} ${path} → ${res.status} ${res.statusText}${
        body ? `\n${body}` : ""
      }`
    );
  }
  return (await res.json()) as T;
}

export async function initiateLogin(
  server: string,
  label: string
): Promise<InitiateResponse> {
  return request<InitiateResponse>(server, "/api/cli-auth/initiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
}

export async function pollLogin(
  server: string,
  code: string
): Promise<PollResponse> {
  return request<PollResponse>(
    server,
    `/api/cli-auth/poll?code=${encodeURIComponent(code)}`
  );
}

export async function fetchLocalBundle(
  server: string,
  token: string,
  envId: string
): Promise<LocalBundleResponse> {
  return request<LocalBundleResponse>(
    server,
    `/api/envs/${encodeURIComponent(envId)}/local-bundle`,
    { headers: { authorization: `Bearer ${token}` } }
  );
}

export type ExportReadinessResponse = {
  ready: boolean;
  repos: {
    name: string;
    branch: string | null;
    uncommitted: number;
    unpushed: number;
    error: string | null;
  }[];
};

export async function fetchExportReadiness(
  server: string,
  token: string,
  envId: string
): Promise<ExportReadinessResponse> {
  return request<ExportReadinessResponse>(
    server,
    `/api/envs/${encodeURIComponent(envId)}/export-readiness`,
    { headers: { authorization: `Bearer ${token}` } }
  );
}
