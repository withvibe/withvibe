// Single source of truth for the image set the api spawns.
// IMPORTANT: image names + tags must match the defaults baked into the api
// services. If you rename anything here, also update:
//   - apps/api/src/runner/claude-runner.service.ts (CLAUDE_RUNNER_IMAGE)
//   - apps/api/src/docker/code-server.service.ts (CODE_SERVER_IMAGE)
//   - apps/api/src/docker/code-tunnel-sidecar.service.ts (CODE_TUNNEL_IMAGE)
//   - apps/api/src/docker/browser-sidecar.service.ts (QA_BROWSER_IMAGE)
//
// Both compose (api/web) and the api-side sidecar spawners resolve the
// effective tag from $WITHVIBE_VERSION at runtime; localName here is the
// :latest fallback used when no version is set (from-source / from-registry).

export type ImageSpec = {
  // Local tag the api expects to find when WITHVIBE_VERSION is unset.
  // Versioned installs (from-bundle) override this with the bundle's tag.
  localName: string;
  // Build context relative to the source repo root.
  contextDir: string;
  // Dockerfile relative to contextDir (Docker default: "Dockerfile").
  dockerfile?: string;
  // Whether this image lives behind a feature flag.
  feature?: "qaBrowser" | "codeServer";
  // Display label for logs.
  label: string;
  // Build args passed to `docker build --build-arg`. Resolved at build time
  // from the install state's tunnel customization (so apt packages and
  // extensions are baked into the image, not installed at entrypoint).
  buildArgs?: (state: BuildArgContext) => Record<string, string>;
};

// Inputs available when computing per-image build args. Sourced from the
// install state — keeps build-args declarative + decoupled from CLI flags.
export type BuildArgContext = {
  codeTunnelAptPackages?: string;
  codeTunnelExtensions?: string;
};

// The 5 images that make up the stack:
//   - api, web      — the long-running services in docker-compose.yml
//   - claude-runner — sidecar (always built; chat needs it)
//   - code-server   — sidecar (feature flag: codeServer)
//   - qa-browser    — sidecar (feature flag: qaBrowser)
export const STACK_IMAGES: ImageSpec[] = [
  {
    localName: "withvibe/api:latest",
    contextDir: ".",
    dockerfile: "apps/api/Dockerfile",
    label: "api",
  },
  {
    localName: "withvibe/web:latest",
    contextDir: ".",
    dockerfile: "apps/web/Dockerfile",
    label: "web",
  },
  {
    localName: "withvibe-claude-runner:latest",
    contextDir: "apps/api/runner",
    label: "claude-runner",
  },
  {
    localName: "withvibe-code-server:latest",
    contextDir: "apps/api/code-server-image",
    feature: "codeServer",
    label: "code-server",
  },
  {
    localName: "withvibe-code-tunnel:latest",
    contextDir: "apps/api/code-tunnel-image",
    label: "code-tunnel",
    buildArgs: (ctx) => {
      const args: Record<string, string> = {};
      if (ctx.codeTunnelAptPackages)
        args.CODE_TUNNEL_APT_PACKAGES = ctx.codeTunnelAptPackages;
      if (ctx.codeTunnelExtensions)
        args.CODE_TUNNEL_EXTENSIONS = ctx.codeTunnelExtensions;
      return args;
    },
  },
  {
    localName: "withvibe-qa-browser:latest",
    contextDir: "apps/api/qa-browser-image",
    feature: "qaBrowser",
    label: "qa-browser",
  },
];

// External images pulled (not built) — postgres for the data plane,
// Traefik for the optional reverse-proxy profile.
export const EXTERNAL_IMAGES = {
  postgres: "postgres:17-alpine",
  traefik: "traefik:v3.1",
} as const;

export function imagesForFeatures(features: {
  qaBrowser: boolean;
  codeServer: boolean;
}): ImageSpec[] {
  return STACK_IMAGES.filter((img) => {
    if (img.feature === "qaBrowser") return features.qaBrowser;
    if (img.feature === "codeServer") return features.codeServer;
    return true;
  });
}

// Map a local image name to its registry-qualified counterpart for a given
// namespace. e.g. ("withvibe/api:latest", "ghcr.io/withvibe", "0.1.0")
//   -> "ghcr.io/withvibe/api:0.1.0"
// Strips the "withvibe/" or "withvibe-" prefix so the same name works under
// any namespace.
export function registryName(
  local: string,
  namespace: string,
  tag: string
): string {
  const [name] = local.split(":");
  if (!name) throw new Error(`Bad image name: ${local}`);
  let stripped = name;
  if (stripped.startsWith("withvibe/")) stripped = stripped.slice("withvibe/".length);
  else if (stripped.startsWith("withvibe-")) stripped = stripped.slice("withvibe-".length);
  return `${namespace.replace(/\/+$/, "")}/${stripped}:${tag}`;
}
