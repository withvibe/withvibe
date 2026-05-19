/**
 * Self-check for the compose-rewriter network topology. This repo has no test
 * runner, so (matching the `check:compose-security` convention) this is a
 * ts-node script:
 *
 *   pnpm --filter @withvibe/api check:compose-rewriter
 *
 * Focus: the Phase 1 multi-tenant isolation invariant —
 *  - Traefik-EXPOSED services ride the shared proxy network (so Traefik can
 *    reach them) AND get `traefik.enable=true`.
 *  - PRIVATE services (DB/cache/anything not exposed) end up on the per-env
 *    `internal` network ONLY. The proxy net is STRIPPED from them even when
 *    the author's compose explicitly attached it (list or map form) — that
 *    stray attachment is exactly the cross-env DB-leak bug this closes.
 *
 * Exits non-zero on any unexpected outcome.
 */
import { parse as parseYaml } from "yaml";
import {
  rewriteComposeForSubdomain,
  readSharedServices,
  readTcpExposed,
  injectPublishedPort,
} from "./compose-rewriter";

let pass = 0;
let fail = 0;
function ok(name: string) {
  pass++;
  console.log(`  ok  ${name}`);
}
function bad(name: string, detail: string) {
  fail++;
  console.log(`FAIL  ${name} — ${detail}`);
}

const PROXY = "proxy";

function rewrite(composeYaml: string) {
  return rewriteComposeForSubdomain({
    composeYaml,
    envId: "clabc123def456", // envShortId → "def456"
    baseDomain: "example.com",
    proxyNetworkName: PROXY,
    traefikEntrypoint: "websecure",
    traefikCertResolver: null,
  });
}

/** Network names a service references, across list and map syntaxes. */
function netNames(svc: unknown): string[] {
  if (svc == null || typeof svc !== "object") return [];
  const n = (svc as Record<string, unknown>).networks;
  if (Array.isArray(n)) return n.map(String);
  if (n && typeof n === "object") return Object.keys(n as object);
  return [];
}
function hasTraefikEnable(svc: unknown): boolean {
  if (svc == null || typeof svc !== "object") return false;
  const labels = (svc as Record<string, unknown>).labels;
  if (Array.isArray(labels))
    return labels.some((l) => String(l).replace(/\s+/g, "") === "traefik.enable=true");
  if (labels && typeof labels === "object")
    return String((labels as Record<string, unknown>)["traefik.enable"]) === "true";
  return false;
}

function expect(name: string, cond: boolean, detail = "") {
  if (cond) ok(name);
  else bad(name, detail || "assertion failed");
}

function main() {
  // ---- 1. ports ⇒ exposed; bare db ⇒ internal-only -------------------
  {
    const r = rewrite(
      `services:\n  web:\n    image: x\n    ports: ["3000:3000"]\n  db:\n    image: postgres\n`
    );
    const m = parseYaml(r.composeYaml);
    const web = m.services.web;
    const db = m.services.db;
    expect(
      "exposed web rides proxy + internal",
      netNames(web).includes(PROXY) && netNames(web).includes("internal"),
      `web networks=${JSON.stringify(netNames(web))}`
    );
    expect("exposed web has traefik.enable=true", hasTraefikEnable(web));
    // Phase 2: the router must point Traefik at the PER-ENV network name we
    // pass in — that's exactly the net the platform `docker network connect`s
    // Traefik to. A mismatch here = unreachable env after Phase 2.
    expect(
      "traefik.docker.network label == the per-env proxy net",
      Array.isArray(web.labels) &&
        web.labels.includes(`traefik.docker.network=${PROXY}`),
      `web labels=${JSON.stringify(web.labels)}`
    );
    expect(
      "private db is internal-only (not on proxy)",
      netNames(db).length === 1 && netNames(db)[0] === "internal",
      `db networks=${JSON.stringify(netNames(db))}`
    );
    expect("db not in exposedServices", !r.exposedServices.includes("db"));
    expect("web has a service URL", !!r.serviceUrls.web);
  }

  // ---- 2. THE BUG: author attached db to proxy (list form) -----------
  {
    const r = rewrite(
      `services:\n  web:\n    image: x\n    ports: ["80:80"]\n  db:\n    image: postgres\n    networks: [proxy, internal]\nnetworks:\n  proxy:\n    external: true\n  internal:\n`
    );
    const db = parseYaml(r.composeYaml).services.db;
    expect(
      "proxy STRIPPED from db when author put it there (list form)",
      !netNames(db).includes(PROXY) && netNames(db).includes("internal"),
      `db networks=${JSON.stringify(netNames(db))}`
    );
  }

  // ---- 3. same, networks as a MAP ------------------------------------
  {
    const r = rewrite(
      `services:\n  db:\n    image: postgres\n    networks:\n      proxy:\n      internal:\nnetworks:\n  proxy:\n    external: true\n  internal:\n`
    );
    const db = parseYaml(r.composeYaml).services.db;
    expect(
      "proxy STRIPPED from db (map form)",
      !netNames(db).includes(PROXY) && netNames(db).includes("internal"),
      `db networks=${JSON.stringify(netNames(db))}`
    );
  }

  // ---- 4. x-expose:false with ports ⇒ private, proxy stripped --------
  {
    const r = rewrite(
      `services:\n  internalapi:\n    image: x\n    ports: ["8080:8080"]\n    x-expose: false\n    networks: [proxy, internal]\nnetworks:\n  proxy:\n    external: true\n  internal:\n`
    );
    const svc = parseYaml(r.composeYaml).services.internalapi;
    expect(
      "x-expose:false ⇒ not exposed",
      !r.exposedServices.includes("internalapi")
    );
    expect(
      "x-expose:false ⇒ proxy stripped, no traefik label",
      !netNames(svc).includes(PROXY) && !hasTraefikEnable(svc),
      `networks=${JSON.stringify(netNames(svc))}`
    );
  }

  // ---- 5. top-level networks block declared --------------------------
  {
    const r = rewrite(
      `services:\n  web:\n    image: x\n    ports: ["3000:3000"]\n`
    );
    const m = parseYaml(r.composeYaml);
    expect(
      "top-level proxy network declared external",
      !!m.networks?.proxy && m.networks.proxy.external === true
    );
    expect("top-level internal network declared", "internal" in (m.networks ?? {}));
  }

  // ---- 6. Phase 3: x-use-shared intent parsing -----------------------
  {
    const got = readSharedServices(
      `services:
  app:
    image: x
    x-use-shared: true
  worker:
    image: y
    x-use-shared: [maindb, cache]
  api:
    image: z
    x-use-shared: "maindb"
  db:
    image: pg
  off:
    image: q
    x-use-shared: false
`
    ).sort();
    expect(
      "readSharedServices: only true/non-empty list/string opt in",
      JSON.stringify(got) === JSON.stringify(["api", "app", "worker"]),
      `got ${JSON.stringify(got)}`
    );
    expect(
      "readSharedServices: no services key ⇒ []",
      readSharedServices("version: '3'\n").length === 0
    );
    expect(
      "readSharedServices: malformed yaml ⇒ [] (no throw)",
      readSharedServices(":\n  - [").length === 0
    );
  }

  // ---- 7. Phase 4: x-expose-tcp parse + port injection ---------------
  {
    const got = readTcpExposed(
      `services:
  db:
    image: postgres
    x-expose-tcp: 5432
  cache:
    image: redis
    x-expose-tcp: "6379"
  web:
    image: x
  bad:
    image: y
    x-expose-tcp: notaport
`
    ).sort((a, b) => a.service.localeCompare(b.service));
    expect(
      "readTcpExposed: numeric + numeric-string only",
      JSON.stringify(got) ===
        JSON.stringify([
          { service: "cache", containerPort: 6379 },
          { service: "db", containerPort: 5432 },
        ]),
      `got ${JSON.stringify(got)}`
    );

    const injected = injectPublishedPort(
      `services:\n  db:\n    image: postgres\n`,
      "db",
      54329,
      5432,
      "10.0.0.5"
    );
    const dbPorts = parseYaml(injected).services.db.ports;
    expect(
      "injectPublishedPort: adds bound host:container mapping",
      Array.isArray(dbPorts) && dbPorts.includes("10.0.0.5:54329:5432"),
      `ports=${JSON.stringify(dbPorts)}`
    );

    // Replaces an existing mapping for the same container port (no dupes).
    const replaced = injectPublishedPort(
      `services:\n  db:\n    image: pg\n    ports: ["5432:5432", "9000:9000"]\n`,
      "db",
      54330,
      5432
    );
    const rp = parseYaml(replaced).services.db.ports;
    expect(
      "injectPublishedPort: replaces same-target, keeps others",
      Array.isArray(rp) &&
        rp.includes("54330:5432") &&
        rp.includes("9000:9000") &&
        !rp.includes("5432:5432"),
      `ports=${JSON.stringify(rp)}`
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
