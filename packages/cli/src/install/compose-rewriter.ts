// Tiny, intentional compose-yaml editor: flips the Traefik service block on/off
// and strips `build:` blocks. Works on the docker-compose.yml the installer
// copies into the install dir at `init` time.
//
// Markers we look for:
//   # >>> withvibe-traefik
//   ... block ...
//   # <<< withvibe-traefik
// If absent, we append the block at the end (still inside `services:`).

// Remove every `build:` mapping nested under a service. The installed compose
// file lives in ~/.withvibe with no source tree alongside it, so leaving the
// `build:` block in means `docker compose up` either tries to build (and
// fails with "no such file or directory: ./apps") or, worse, falls back to
// pulling from a registry that doesn't have these images yet. The installer
// already builds via `withvibe build-images`, so the runtime compose only
// needs `image:` references.
export function stripBuildBlocks(yaml: string): string {
  const lines = yaml.split("\n");
  const out: string[] = [];
  let i = 0;
  // Anything indented deeper than the `build:` line itself belongs to the
  // build block and gets dropped. Two-space indented `build:` is the only
  // shape we ever ship.
  const buildLine = /^(\s+)build:\s*$/;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = line.match(buildLine);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }
    const baseIndent = m[1]!.length;
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === "") {
        i++;
        continue;
      }
      const nextIndent = next.match(/^(\s*)/)![1]!.length;
      if (nextIndent > baseIndent) {
        i++;
        continue;
      }
      break;
    }
  }
  return out.join("\n");
}

// Default to `pull_policy: never` for the api/web services so a missing
// local image fails with a clear error instead of attempting a registry
// pull. Postgres still pulls normally.
export function setNoPull(yaml: string): string {
  // Only insert under services that reference our images. Idempotent: skips
  // if a `pull_policy:` line is already present in the next few lines.
  const lines = yaml.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const m = line.match(/^(\s+)image:\s*(withvibe[\/-][\S]+)\s*$/);
    if (!m) continue;
    // Look ahead for an existing pull_policy: at the same indent.
    const indent = m[1]!;
    let already = false;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/^\s*pull_policy:/.test(lines[j]!)) {
        already = true;
        break;
      }
      // Stop when we leave this service's block.
      const next = lines[j]!;
      if (next.trim() && !next.startsWith(indent)) break;
    }
    if (!already) out.push(`${indent}pull_policy: never`);
  }
  return out.join("\n");
}

// Markers must be mutually un-prefix: `indexOf("# >>> withvibe-traefik")`
// would otherwise match `# >>> withvibe-traefik-volume` too and corrupt
// later removals. Using `-service` rather than the bare `-traefik` keeps
// every marker pair unique.
const TRAEFIK_BEGIN = "# >>> withvibe-traefik-service";
const TRAEFIK_END = "# <<< withvibe-traefik-service";

// HTTPS variant — used when the base domain is a real public domain, so
// Let's Encrypt can successfully complete the TLS challenge.
//
// IMPORTANT: routing labels go on the *web* service block (see
// WEB_LABELS_* constants below), not on the traefik container itself.
// With Traefik's Docker provider, labels declare the *container they're
// on* as the backend — putting `traefik.http.services.web.loadbalancer.
// server.port=3000` on the traefik container makes Traefik try to forward
// to its own port 3000 (where nothing listens) → 502 on every request.
const TRAEFIK_BLOCK_TLS = `${TRAEFIK_BEGIN}
  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    command:
      - "--api.dashboard=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      - "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.email=\${TRAEFIK_ACME_EMAIL}"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      - "--certificatesresolvers.letsencrypt.acme.tlschallenge=true"
    ports:
      - "\${TRAEFIK_HTTP_HOST_PORT:-80}:80"
      - "\${TRAEFIK_HTTPS_HOST_PORT:-443}:443"
    volumes:
      - traefik-letsencrypt:/letsencrypt
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [withvibe]
${TRAEFIK_END}`;

// HTTP-only variant — used for local installs (PUBLIC_HOST=localhost) where
// ACME would fail forever since the host has no public DNS. Still routes
// traffic by Host header so multi-subdomain envs work behind something like
// dnsmasq pointing *.localhost at 127.0.0.1.
const TRAEFIK_BLOCK_PLAIN = `${TRAEFIK_BEGIN}
  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    command:
      - "--api.dashboard=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
    ports:
      - "\${TRAEFIK_HTTP_HOST_PORT:-80}:80"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [withvibe]
${TRAEFIK_END}`;

// Bring-your-own-certificate variant — TLS on :443 but Traefik loads the
// operator's cert via the file provider instead of requesting one from
// Let's Encrypt. The cert/key and the dynamic config are bind-mounted from
// the install dir (written by `withvibe configure`). No ACME, no outbound
// 443 needed — for corporate/wildcard certs and air-gapped installs.
const TRAEFIK_BLOCK_BYOCERT = `${TRAEFIK_BEGIN}
  traefik:
    image: traefik:v3.1
    restart: unless-stopped
    command:
      - "--api.dashboard=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--providers.file.directory=/etc/traefik/dynamic"
      - "--providers.file.watch=true"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.web.http.redirections.entrypoint.to=websecure"
      - "--entrypoints.web.http.redirections.entrypoint.scheme=https"
      - "--entrypoints.websecure.address=:443"
    ports:
      - "\${TRAEFIK_HTTP_HOST_PORT:-80}:80"
      - "\${TRAEFIK_HTTPS_HOST_PORT:-443}:443"
    volumes:
      - ./certs:/certs:ro
      - ./traefik-dynamic:/etc/traefik/dynamic:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [withvibe]
${TRAEFIK_END}`;

// Traefik dynamic config that points the default TLS store at the operator's
// mounted cert. Written to <installDir>/traefik-dynamic/tls.yml.
export const TRAEFIK_BYOCERT_DYNAMIC = `# Managed by withvibe — bring-your-own-certificate TLS.
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /certs/tls.crt
        keyFile: /certs/tls.key
  certificates:
    - certFile: /certs/tls.crt
      keyFile: /certs/tls.key
`;

// Markers + body for the routing labels that get injected into the web
// service block. Variants — TLS (websecure + ACME resolver), BYOCERT
// (websecure + Traefik's own cert), PLAIN (web entrypoint, no TLS).
// Marker-bracketed so swapping modes is idempotent and we don't accumulate
// stale labels on flip.
const WEB_LABELS_BEGIN = "# >>> withvibe-web-labels";
const WEB_LABELS_END = "# <<< withvibe-web-labels";

const WEB_LABELS_TLS = `    ${WEB_LABELS_BEGIN}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.web.rule=Host(\`\${TRAEFIK_BASE_DOMAIN}\`)"
      - "traefik.http.routers.web.entrypoints=websecure"
      - "traefik.http.routers.web.tls.certresolver=letsencrypt"
      - "traefik.http.services.web.loadbalancer.server.port=3000"
    ${WEB_LABELS_END}`;

const WEB_LABELS_BYOCERT = `    ${WEB_LABELS_BEGIN}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.web.rule=Host(\`\${TRAEFIK_BASE_DOMAIN}\`)"
      - "traefik.http.routers.web.entrypoints=websecure"
      - "traefik.http.routers.web.tls=true"
      - "traefik.http.services.web.loadbalancer.server.port=3000"
    ${WEB_LABELS_END}`;

const WEB_LABELS_PLAIN = `    ${WEB_LABELS_BEGIN}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.web.rule=Host(\`\${TRAEFIK_BASE_DOMAIN}\`)"
      - "traefik.http.routers.web.entrypoints=web"
      - "traefik.http.services.web.loadbalancer.server.port=3000"
    ${WEB_LABELS_END}`;

// Routing labels for the *api* service. Most /api/* traffic is handled by
// Next.js (Route Handlers / rewrites that forward to the api over the
// compose network), so the catch-all `web` router stays the default. But a
// few endpoints must reach NestJS directly because Next.js can't carry them:
//
//   - /api/terminal/         — xterm WebSocket (Next rewrites don't upgrade)
//   - /api/qa-browser/ws/    — QA-extension pairing WebSocket
//   - /api/qa-browser/view/  — QA-browser noVNC viewer page + asset proxy
//   - /api/qa-browser/view-ws/ — QA-browser noVNC frame relay WebSocket
//   - /api/code-server/view/ — code-server reverse proxy (HTTP + WS)
//   - /api/db-viewer/view/   — Adminer reverse proxy (HTTP)
//
// This router is more specific than `web` (Host + PathPrefix) and pinned to
// a high priority so it wins for exactly those prefixes and nothing else.
// Without it the browser has no public path to the api on a domain deploy,
// which is why the QA browser / Terminal pointed at 127.0.0.1 / localhost.
const API_ROUTE_RULE =
  "Host(`${TRAEFIK_BASE_DOMAIN}`) && (PathPrefix(`/api/terminal/`) || PathPrefix(`/api/qa-browser/ws/`) || PathPrefix(`/api/qa-browser/view/`) || PathPrefix(`/api/qa-browser/view-ws/`) || PathPrefix(`/api/code-server/view/`) || PathPrefix(`/api/db-viewer/view/`))";

const API_LABELS_BEGIN = "# >>> withvibe-api-labels";
const API_LABELS_END = "# <<< withvibe-api-labels";

const API_LABELS_TLS = `    ${API_LABELS_BEGIN}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.wvapi.rule=${API_ROUTE_RULE}"
      - "traefik.http.routers.wvapi.entrypoints=websecure"
      - "traefik.http.routers.wvapi.tls.certresolver=letsencrypt"
      - "traefik.http.routers.wvapi.priority=1000"
      - "traefik.http.services.wvapi.loadbalancer.server.port=4000"
    ${API_LABELS_END}`;

const API_LABELS_BYOCERT = `    ${API_LABELS_BEGIN}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.wvapi.rule=${API_ROUTE_RULE}"
      - "traefik.http.routers.wvapi.entrypoints=websecure"
      - "traefik.http.routers.wvapi.tls=true"
      - "traefik.http.routers.wvapi.priority=1000"
      - "traefik.http.services.wvapi.loadbalancer.server.port=4000"
    ${API_LABELS_END}`;

const API_LABELS_PLAIN = `    ${API_LABELS_BEGIN}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.wvapi.rule=${API_ROUTE_RULE}"
      - "traefik.http.routers.wvapi.entrypoints=web"
      - "traefik.http.routers.wvapi.priority=1000"
      - "traefik.http.services.wvapi.loadbalancer.server.port=4000"
    ${API_LABELS_END}`;

const TRAEFIK_VOLUME_BEGIN = "# >>> withvibe-traefik-volume";
const TRAEFIK_VOLUME_END = "# <<< withvibe-traefik-volume";
const TRAEFIK_VOLUME_BLOCK = `${TRAEFIK_VOLUME_BEGIN}
  traefik-letsencrypt:
${TRAEFIK_VOLUME_END}`;

export type TraefikMode = "tls" | "plain";
export type TraefikCertMode = "acme" | "byocert";

// Decide which variant to emit based on the base domain. localhost-shaped
// values can't get a real cert, so fall back to plain HTTP automatically.
export function pickTraefikMode(baseDomain: string | undefined): TraefikMode {
  const d = (baseDomain ?? "").toLowerCase().trim();
  if (!d) return "plain";
  if (d === "localhost" || d.endsWith(".localhost")) return "plain";
  if (d.endsWith(".local")) return "plain";
  return "tls";
}

export function setTraefik(
  yaml: string,
  enabled: boolean,
  baseDomain?: string,
  certMode: TraefikCertMode = "acme"
): string {
  const mode = pickTraefikMode(baseDomain);
  const byo = mode === "tls" && certMode === "byocert";
  const block =
    mode !== "tls"
      ? TRAEFIK_BLOCK_PLAIN
      : byo
        ? TRAEFIK_BLOCK_BYOCERT
        : TRAEFIK_BLOCK_TLS;
  const webLabels =
    mode !== "tls"
      ? WEB_LABELS_PLAIN
      : byo
        ? WEB_LABELS_BYOCERT
        : WEB_LABELS_TLS;
  const apiLabels =
    mode !== "tls"
      ? API_LABELS_PLAIN
      : byo
        ? API_LABELS_BYOCERT
        : API_LABELS_TLS;
  // The Let's Encrypt named volume is only needed for ACME.
  const wantVolume = enabled && mode === "tls" && !byo;

  // Always strip first so a switch tls↔plain swaps the body cleanly.
  let out = yaml;
  out = setSection(out, TRAEFIK_BEGIN, TRAEFIK_END, block, false, "services");
  out = setSection(
    out,
    TRAEFIK_VOLUME_BEGIN,
    TRAEFIK_VOLUME_END,
    TRAEFIK_VOLUME_BLOCK,
    false,
    "volumes"
  );
  out = setWebLabels(out, "");
  out = setApiLabels(out, "");
  if (!enabled) return out;

  out = setSection(out, TRAEFIK_BEGIN, TRAEFIK_END, block, true, "services");
  out = setSection(
    out,
    TRAEFIK_VOLUME_BEGIN,
    TRAEFIK_VOLUME_END,
    TRAEFIK_VOLUME_BLOCK,
    wantVolume,
    "volumes"
  );
  out = setWebLabels(out, webLabels);
  out = setApiLabels(out, apiLabels);
  return out;
}

// Inject (or remove, by passing "") the marker-bracketed Traefik labels
// block into the `web` service. Idempotent: running the same call twice
// is a no-op, and switching tls↔plain swaps the body in place. We attach
// the labels to the web service rather than the traefik service because
// Traefik's Docker provider treats container labels as backend
// declarations — labels on the traefik container itself would route to
// the traefik container's own port, which is the wrong target.
function setWebLabels(yaml: string, block: string): string {
  return setServiceLabels(
    yaml,
    "web",
    WEB_LABELS_BEGIN,
    WEB_LABELS_END,
    block
  );
}

// Same as setWebLabels but for the `api` service — injects the high-priority
// router that sends WebSocket / noVNC-proxy prefixes straight to NestJS.
function setApiLabels(yaml: string, block: string): string {
  return setServiceLabels(
    yaml,
    "api",
    API_LABELS_BEGIN,
    API_LABELS_END,
    block
  );
}

function setServiceLabels(
  yaml: string,
  service: "web" | "api",
  beginMarker: string,
  endMarker: string,
  block: string
): string {
  // Remove any existing block first.
  const beginIdx = yaml.indexOf(beginMarker);
  if (beginIdx !== -1) {
    const endIdx = yaml.indexOf(endMarker, beginIdx);
    if (endIdx !== -1) {
      const after = endIdx + endMarker.length;
      // Eat the trailing newline so we don't leave a blank line behind.
      const eatNewline = yaml[after] === "\n" ? 1 : 0;
      // And eat the indentation that preceded the begin marker on the
      // same line (so removal leaves a clean line break).
      let lineStart = beginIdx;
      while (lineStart > 0 && yaml[lineStart - 1] === " ") lineStart--;
      yaml = yaml.slice(0, lineStart) + yaml.slice(after + eatNewline);
    }
  }
  if (!block) return yaml;

  // Insert at the end of the service block. Find the `  <service>:` line
  // (two-space indent), then walk forward until we hit either another
  // top-level service (line with same indent) or a top-level key.
  const serviceRe = new RegExp(`(^|\\n)  ${service}:\\s*\\n`);
  const m = yaml.match(serviceRe);
  if (!m) return yaml; // no such service to label — leave as-is
  const webStart = m.index! + m[0].length;
  const after = yaml.slice(webStart);
  const lines = after.split("\n");
  let cutAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    if (/^    /.test(line) || /^  #/.test(line)) continue; // child of service
    cutAt = i;
    break;
  }
  const beforeLines = lines.slice(0, cutAt).join("\n").replace(/\n*$/, "");
  const afterLines = lines.slice(cutAt).join("\n");
  return (
    yaml.slice(0, webStart) +
    beforeLines +
    "\n" +
    block +
    "\n" +
    (afterLines ? afterLines : "")
  );
}

// Insert/remove a marker-bracketed block under a given top-level key.
function setSection(
  yaml: string,
  begin: string,
  end: string,
  block: string,
  enabled: boolean,
  parentKey: "services" | "volumes"
): string {
  const has = yaml.includes(begin) && yaml.includes(end);

  if (!enabled) {
    if (!has) return yaml;
    const startIdx = yaml.indexOf(begin);
    const endIdx = yaml.indexOf(end, startIdx) + end.length;
    let cut = yaml.slice(0, startIdx) + yaml.slice(endIdx);
    // Strip the line-trailing newline we leave behind when removing.
    cut = cut.replace(/\n{3,}/g, "\n\n");
    return cut;
  }

  if (has) return yaml; // already enabled; no-op

  // Find the parent key. If `volumes:` doesn't exist yet, create it at the end.
  const keyRe = new RegExp(`(^|\\n)${parentKey}:\\s*\\n`);
  const m = yaml.match(keyRe);
  if (!m) {
    // No parent key — append a new one with this block as its first child.
    return `${yaml.replace(/\n*$/, "")}\n\n${parentKey}:\n${block}\n`;
  }

  // Insert at the END of the parent block. Parent block ends at next
  // top-level key (a non-indented line that isn't blank/comment) or EOF.
  const parentStart = m.index! + m[0].length;
  const after = yaml.slice(parentStart);
  const lines = after.split("\n");
  let cutAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length === 0) continue;
    if (/^\s/.test(line)) continue;
    if (line.startsWith("#")) continue;
    cutAt = i;
    break;
  }
  const beforeBlock = lines.slice(0, cutAt).join("\n").replace(/\n*$/, "");
  const afterBlock = lines.slice(cutAt).join("\n");
  return (
    yaml.slice(0, parentStart) +
    beforeBlock +
    "\n" +
    block +
    "\n" +
    (afterBlock ? afterBlock : "")
  );
}
