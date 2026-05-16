import { parseDocument, YAMLMap, YAMLSeq, Scalar, isMap, isSeq } from "yaml";

export type RewriteInput = {
  composeYaml: string;
  envId: string;
  baseDomain: string;
  // Name of the external Docker network Traefik is attached to. The exposed
  // services are joined to this network and Traefik labels point at it.
  // Must match the `name:` of the Traefik network on the host.
  proxyNetworkName: string;
  // Traefik entrypoint name to bind the env's router to (matches Traefik's
  // static config — typically "websecure" for the :443 entrypoint).
  traefikEntrypoint: string;
  // Traefik certresolver name for Let's Encrypt (must match Traefik's
  // static config). Pass null to disable TLS labels — useful for plain-HTTP
  // setups (e.g. behind an external TLS terminator or for local dev).
  traefikCertResolver: string | null;
};

export type RewriteOutput = {
  composeYaml: string;
  serviceUrls: Record<string, string>;
  exposedServices: string[];
};

// Per-env short identifier used in subdomains: last 6 chars of cuid, lowercase.
// cuids are already lowercase alphanumeric, DNS-safe.
export function envShortId(envId: string): string {
  return envId.slice(-6).toLowerCase();
}

// When a template uses a repo's own docker-compose.yml verbatim, that compose
// expects relative build paths to resolve next to the repo root. Once we
// move the compose up to the env root, "build: ." now points at the env dir
// (no Dockerfile there) and the build fails. This helper prefixes relative
// `build:` / `build.context` / `build.dockerfile` paths with `<subdir>/` so
// they keep pointing inside the repo. Absolute paths and remote git/url
// contexts are left alone.
export function rebaseBuildPaths(composeYaml: string, subdir: string): string {
  const doc = parseDocument(composeYaml);
  const root = doc.contents;
  if (!isMap(root)) return composeYaml;
  const services = root.get("services", true);
  if (!isMap(services)) return composeYaml;

  const prefix = subdir.replace(/^\/+|\/+$/g, "");
  if (!prefix) return composeYaml;
  const isRelative = (p: string): boolean =>
    p.length > 0 &&
    !p.startsWith("/") &&
    !/^[a-z][a-z0-9+.-]*:\/\//i.test(p) && // url scheme
    !p.startsWith("git@") &&
    !p.startsWith("github.com/");

  for (const pair of services.items) {
    const svc = pair.value;
    if (!isMap(svc)) continue;
    const build = svc.get("build", true);
    if (build instanceof Scalar && typeof build.value === "string") {
      if (isRelative(build.value)) {
        build.value = `./${prefix}/${build.value.replace(/^\.\/?/, "")}`.replace(
          /\/+$/,
          ""
        );
      }
      continue;
    }
    if (isMap(build)) {
      const ctx = build.get("context");
      if (typeof ctx === "string" && isRelative(ctx)) {
        build.set(
          "context",
          `./${prefix}/${ctx.replace(/^\.\/?/, "")}`.replace(/\/+$/, "")
        );
      } else if (
        ctx instanceof Scalar &&
        typeof ctx.value === "string" &&
        isRelative(ctx.value)
      ) {
        ctx.value = `./${prefix}/${ctx.value.replace(/^\.\/?/, "")}`.replace(
          /\/+$/,
          ""
        );
      }
    }
  }
  return doc.toString();
}

// Rewrites a docker-compose YAML for subdomain-based routing via Traefik.
// - strips `ports:` from exposed services (they're reached via the proxy, not host ports)
// - attaches exposed services to the external proxy network + a per-env `internal` network
// - injects Traefik router+service labels with a Host(...) rule per exposed service
// - adds top-level `networks:` entries for the proxy (external) and `internal`
//
// "Exposed" = the service had `ports:` in the source OR an `x-expose: true` extension.
// Opt out via `x-expose: false`. Override the subdomain label via `x-subdomain: <name>`.
//
// Returns the rewritten YAML plus a map of service → full URL for the UI to display.
export function rewriteComposeForSubdomain(input: RewriteInput): RewriteOutput {
  const {
    composeYaml,
    envId,
    baseDomain,
    proxyNetworkName,
    traefikEntrypoint,
    traefikCertResolver,
  } = input;
  const short = envShortId(envId);
  const scheme = isHttpsDomain(baseDomain) ? "https" : "http";

  const doc = parseDocument(composeYaml);
  const root = doc.contents;
  if (!isMap(root)) {
    throw new Error("docker-compose.yml root is not a mapping");
  }

  const services = root.get("services", true);
  if (!isMap(services)) {
    return {
      composeYaml,
      serviceUrls: {},
      exposedServices: [],
    };
  }

  const serviceUrls: Record<string, string> = {};
  const exposedServices: string[] = [];

  for (const pair of services.items) {
    const svcName = keyString(pair.key);
    const svc = pair.value;
    if (!svcName || !isMap(svc)) continue;

    const hasPorts = isSeq(svc.get("ports", true));
    const hasTraefikLabels = hasTraefikEnableLabel(svc);
    const xExpose = svc.get("x-expose");
    // Explicit opt-out wins. Exposed if ports, x-expose=true, or the template
    // already had traefik.enable=true (idempotent: re-feeding a pre-routed
    // compose refreshes env-specific bits but keeps the author's intent).
    if (xExpose === false) continue;
    const exposed = xExpose === true || hasPorts || hasTraefikLabels;
    if (!exposed) continue;

    const xSubdomain = readScalarString(svc, "x-subdomain");
    const sub = xSubdomain || svcName;
    const host = `${sub}.env-${short}.${baseDomain}`;
    const routerId = `env-${short}-${svcName}`;
    // Authoritative port priority: explicit existing traefik server.port label
    // (template author's intent) → ports → expose → x-port → 80.
    const targetPort =
      readExistingTraefikServerPort(svc) ?? extractInternalPort(svc);

    svc.delete("ports");

    attachNetworks(svc, [proxyNetworkName, "internal"]);

    // Strip any pre-existing traefik.* labels so a pasted-in pre-routed compose
    // doesn't leave stale routers pointing at a hostname we're no longer using.
    stripTraefikLabels(svc);

    const labels = buildLabels({
      routerId,
      host,
      targetPort,
      proxyNetworkName,
      traefikEntrypoint,
      traefikCertResolver,
    });
    mergeLabels(svc, labels);

    exposedServices.push(svcName);
    serviceUrls[svcName] = `${scheme}://${host}`;
  }

  // Ensure top-level networks block has the proxy (external) and `internal`.
  ensureTopLevelNetworks(root, proxyNetworkName);

  // Non-exposed services (e.g. postgres) still need the internal network so
  // exposed services can reach them. Do this in a second pass so we don't
  // accidentally add the proxy network to internal-only services.
  for (const pair of services.items) {
    const svc = pair.value;
    if (!isMap(svc)) continue;
    if (!exposedServices.includes(keyString(pair.key) ?? "")) {
      attachNetworks(svc, ["internal"]);
    }
  }

  return {
    composeYaml: doc.toString(),
    serviceUrls,
    exposedServices,
  };
}

function keyString(k: unknown): string | null {
  if (typeof k === "string") return k;
  if (k instanceof Scalar && typeof k.value === "string") return k.value;
  return null;
}

function readScalarString(map: YAMLMap, key: string): string | null {
  const v = map.get(key, true);
  if (v instanceof Scalar && typeof v.value === "string") return v.value;
  if (typeof v === "string") return v;
  return null;
}

// Derive the container-internal port to point Traefik at. Priority:
//   1. `expose: [N]` → first entry
//   2. source `ports: ["HOST:TARGET"]` → TARGET of first entry
//   3. `x-port` extension
//   4. fallback to 80
function extractInternalPort(svc: YAMLMap): number {
  const expose = svc.get("expose", true);
  if (isSeq(expose) && expose.items.length > 0) {
    const p = asPortNumber(expose.items[0]);
    if (p) return p;
  }
  const ports = svc.get("ports", true);
  if (isSeq(ports) && ports.items.length > 0) {
    const first = ports.items[0];
    const asStr = first instanceof Scalar ? String(first.value) : null;
    if (asStr) {
      // "3000", "3000:3000", "127.0.0.1:3000:3000" — we want the last numeric segment
      const segments = asStr.split(":");
      const last = segments[segments.length - 1];
      const m = /^(\d+)(?:\/(tcp|udp))?$/.exec(last);
      if (m) return Number(m[1]);
    }
  }
  const xPort = svc.get("x-port", true);
  const p = asPortNumber(xPort);
  if (p) return p;
  return 80;
}

function asPortNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v instanceof Scalar) {
    if (typeof v.value === "number") return v.value;
    if (typeof v.value === "string" && /^\d+$/.test(v.value)) return Number(v.value);
  }
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

function attachNetworks(svc: YAMLMap, wanted: string[]) {
  const existing = svc.get("networks", true);
  if (existing == null) {
    svc.set("networks", wanted.slice());
    return;
  }
  // networks as a list of strings: ["foo", "bar"]
  if (isSeq(existing)) {
    const present = new Set(
      existing.items
        .map((i) => (i instanceof Scalar ? String(i.value) : null))
        .filter((x): x is string => !!x)
    );
    for (const name of wanted) {
      if (!present.has(name)) existing.add(name);
    }
    return;
  }
  // networks as a map: { foo: {...}, bar: null }. Add missing keys as null.
  if (isMap(existing)) {
    for (const name of wanted) {
      if (!existing.has(name)) existing.set(name, null);
    }
    return;
  }
}

type LabelSpec = {
  routerId: string;
  host: string;
  targetPort: number;
  proxyNetworkName: string;
  traefikEntrypoint: string;
  traefikCertResolver: string | null;
};

function buildLabels({
  routerId,
  host,
  targetPort,
  proxyNetworkName,
  traefikEntrypoint,
  traefikCertResolver,
}: LabelSpec): string[] {
  const labels = [
    "traefik.enable=true",
    `traefik.docker.network=${proxyNetworkName}`,
    `traefik.http.routers.${routerId}.rule=Host(\`${host}\`)`,
    `traefik.http.routers.${routerId}.entrypoints=${traefikEntrypoint}`,
    `traefik.http.services.${routerId}.loadbalancer.server.port=${targetPort}`,
  ];
  // Cert resolver is optional: setting both `tls=true` and a resolver tells
  // Traefik to obtain a cert via that resolver; omit them entirely when the
  // operator handles TLS upstream (e.g. an external load balancer) or runs
  // local dev over plain HTTP.
  if (traefikCertResolver) {
    labels.push(
      `traefik.http.routers.${routerId}.tls=true`,
      `traefik.http.routers.${routerId}.tls.certresolver=${traefikCertResolver}`
    );
  }
  return labels;
}

function hasTraefikEnableLabel(svc: YAMLMap): boolean {
  const labels = svc.get("labels", true);
  if (isSeq(labels)) {
    for (const item of labels.items) {
      const str = item instanceof Scalar ? String(item.value) : null;
      if (str === "traefik.enable=true") return true;
    }
    return false;
  }
  if (isMap(labels)) {
    const v = labels.get("traefik.enable");
    if (v === true || v === "true") return true;
    if (v instanceof Scalar && (v.value === true || v.value === "true"))
      return true;
  }
  return false;
}

// If the service already declares `traefik.http.services.<id>.loadbalancer.server.port=<N>`,
// return N — the template author explicitly picked that port. We prefer it
// over port heuristics so stripping `ports:` and re-injecting doesn't
// accidentally route to a non-HTTP port like JDWP/5005.
function readExistingTraefikServerPort(svc: YAMLMap): number | null {
  const labels = svc.get("labels", true);
  const check = (raw: string): number | null => {
    const m = /^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port=(\d+)$/.exec(
      raw
    );
    return m ? Number(m[1]) : null;
  };
  if (isSeq(labels)) {
    for (const item of labels.items) {
      const str = item instanceof Scalar ? String(item.value) : null;
      if (!str) continue;
      const n = check(str);
      if (n) return n;
    }
    return null;
  }
  if (isMap(labels)) {
    for (const pair of labels.items) {
      const k = pair.key instanceof Scalar ? String(pair.key.value) : null;
      const v = pair.value instanceof Scalar ? String(pair.value.value) : null;
      if (!k || !v) continue;
      const m = /^traefik\.http\.services\.[^.]+\.loadbalancer\.server\.port$/.exec(
        k
      );
      if (m && /^\d+$/.test(v)) return Number(v);
    }
  }
  return null;
}

function stripTraefikLabels(svc: YAMLMap) {
  const existing = svc.get("labels", true);
  if (isSeq(existing)) {
    existing.items = existing.items.filter((i) => {
      const str = i instanceof Scalar ? String(i.value) : null;
      return !(str && str.startsWith("traefik."));
    });
    return;
  }
  if (isMap(existing)) {
    const keysToRemove: string[] = [];
    for (const pair of existing.items) {
      const k = pair.key instanceof Scalar ? String(pair.key.value) : null;
      if (k && k.startsWith("traefik.")) keysToRemove.push(k);
    }
    for (const k of keysToRemove) existing.delete(k);
  }
}

function mergeLabels(svc: YAMLMap, add: string[]) {
  const existing = svc.get("labels", true);
  if (existing == null) {
    svc.set("labels", add);
    return;
  }
  if (isSeq(existing)) {
    for (const l of add) existing.add(l);
    return;
  }
  // labels as a map — convert "key=val" → map entries
  if (isMap(existing)) {
    for (const l of add) {
      const eq = l.indexOf("=");
      const k = l.slice(0, eq);
      const v = l.slice(eq + 1);
      existing.set(k, v);
    }
    return;
  }
}

function ensureTopLevelNetworks(root: YAMLMap, proxyNetworkName: string) {
  const current = root.get("networks", true);
  const networks: YAMLMap = isMap(current) ? current : new YAMLMap();
  if (!isMap(current)) {
    root.set("networks", networks);
  }
  if (!networks.has(proxyNetworkName)) {
    const proxy = new YAMLMap();
    proxy.set("external", true);
    networks.set(proxyNetworkName, proxy);
  }
  if (!networks.has("internal")) {
    networks.set("internal", null);
  }
}

function isHttpsDomain(baseDomain: string): boolean {
  // localhost / *.localhost / nip.io aliases → http. Everything else → https.
  if (baseDomain === "localhost") return false;
  if (baseDomain.endsWith(".localhost")) return false;
  if (baseDomain.endsWith(".nip.io")) return false;
  if (baseDomain.endsWith(".sslip.io")) return false;
  return true;
}
