/**
 * Self-check for the compose-security gate. This repo has no test runner, so
 * (matching the existing `bench:chat` convention) this is a ts-node script:
 *
 *   pnpm --filter @withvibe/api check:compose-security
 *
 * It exercises:
 *  - the save-time prewrite path (`assertComposeStringSafe`) over a corpus
 *    of malicious composes that MUST be rejected and legitimate ones that
 *    MUST pass, including a YAML-anchor/merge-smuggled `privileged: true`
 *    and a `${VAR}`-smuggled bind source;
 *  - the authoritative runtime containment logic (`__internal.assertModelSafe`)
 *    over a synthetic *resolved* model (what `docker compose config` emits:
 *    long-form volumes with absolute sources), including a real on-disk
 *    symlink-escape that realpath containment must defeat.
 *
 * The `docker compose config` resolver itself needs a daemon and is exercised
 * by the running system; this script covers all the decision logic offline.
 * Exits non-zero on any unexpected outcome.
 */
import { mkdtemp, mkdir, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import {
  assertComposeStringSafe,
  ComposeSecurityError,
  __internal,
} from "./compose-security";

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

type Opts = { allowedExternalNetworks?: string[] };

function expectReject(name: string, yaml: string, opts?: Opts) {
  try {
    assertComposeStringSafe(yaml, opts);
    bad(name, "expected rejection, but it passed");
  } catch (e) {
    if (e instanceof ComposeSecurityError) ok(name);
    else bad(name, `threw unexpected ${(e as Error).name}: ${(e as Error).message}`);
  }
}

function expectPass(name: string, yaml: string, opts?: Opts) {
  try {
    assertComposeStringSafe(yaml, opts);
    ok(name);
  } catch (e) {
    bad(name, `expected pass, got: ${(e as Error).message}`);
  }
}

async function expectModelReject(
  name: string,
  model: unknown,
  root: string,
  allowed: string[] = []
) {
  try {
    await __internal.assertModelSafe(model, root, new Set(allowed));
    bad(name, "expected rejection, but it passed");
  } catch (e) {
    if (e instanceof ComposeSecurityError) ok(name);
    else bad(name, `threw unexpected: ${(e as Error).message}`);
  }
}

async function expectModelPass(
  name: string,
  model: unknown,
  root: string,
  allowed: string[] = []
) {
  try {
    await __internal.assertModelSafe(model, root, new Set(allowed));
    ok(name);
  } catch (e) {
    bad(name, `expected pass, got: ${(e as Error).message}`);
  }
}

async function main() {
  // ---- prewrite: MUST be rejected -------------------------------------
  expectReject("privileged", `services:\n  a:\n    image: x\n    privileged: true\n`);
  expectReject("cap_add", `services:\n  a:\n    image: x\n    cap_add: [SYS_ADMIN]\n`);
  expectReject("pid host", `services:\n  a:\n    image: x\n    pid: "host"\n`);
  expectReject("ipc host", `services:\n  a:\n    image: x\n    ipc: host\n`);
  expectReject("uts host", `services:\n  a:\n    image: x\n    uts: host\n`);
  expectReject("userns host", `services:\n  a:\n    image: x\n    userns_mode: host\n`);
  expectReject("network_mode host", `services:\n  a:\n    image: x\n    network_mode: host\n`);
  expectReject("network_mode container", `services:\n  a:\n    image: x\n    network_mode: "container:foo"\n`);
  expectReject("bind root", `services:\n  a:\n    image: x\n    volumes: ["/:/host"]\n`);
  expectReject("bind docker.sock", `services:\n  a:\n    image: x\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`);
  expectReject("bind .. escape", `services:\n  a:\n    image: x\n    volumes: ["../../../../etc:/etc"]\n`);
  expectReject("bind /etc", `services:\n  a:\n    image: x\n    volumes:\n      - "/etc:/host-etc"\n`);
  expectReject("seccomp unconfined", `services:\n  a:\n    image: x\n    security_opt: ["seccomp=unconfined"]\n`);
  expectReject("apparmor unconfined", `services:\n  a:\n    image: x\n    security_opt: ["apparmor:unconfined"]\n`);
  expectReject("devices", `services:\n  a:\n    image: x\n    devices: ["/dev/sda:/dev/sda"]\n`);
  expectReject("volumes_from", `services:\n  a:\n    image: x\n    volumes_from: ["b"]\n`);
  expectReject("cgroup_parent", `services:\n  a:\n    image: x\n    cgroup_parent: /bad\n`);
  expectReject(
    "external network rejected by default (no allowlist)",
    `services:\n  a:\n    image: x\n    networks: [withvibe]\nnetworks:\n  withvibe:\n    external: true\n`
  );
  expectReject(
    "non-proxy external network rejected even with proxy allowlisted",
    `services:\n  a:\n    image: x\n    networks: [withvibe]\nnetworks:\n  withvibe:\n    external: true\n`,
    { allowedExternalNetworks: ["proxy"] }
  );
  expectReject(
    "external via name: override to a non-allowed net",
    `services:\n  a:\n    image: x\n    networks: [web]\nnetworks:\n  web:\n    external: true\n    name: withvibe\n`,
    { allowedExternalNetworks: ["proxy"] }
  );
  expectReject(
    "external volume",
    `services:\n  a:\n    image: x\n    volumes: ["v:/d"]\nvolumes:\n  v:\n    external: true\n`
  );
  expectReject(
    "named volume driver_opts bind to /",
    `services:\n  a:\n    image: x\n    volumes: ["v:/d"]\nvolumes:\n  v:\n    driver_opts:\n      type: none\n      o: bind\n      device: /\n`
  );
  expectReject(
    "${VAR}-smuggled bind source",
    `services:\n  a:\n    image: x\n    volumes:\n      - "\${HOST_ROOT}:/host"\n`
  );
  // YAML anchor + merge key smuggling `privileged: true` into a service.
  expectReject(
    "anchor/merge-smuggled privileged",
    `x-evil: &evil\n  privileged: true\nservices:\n  a:\n    image: x\n    <<: *evil\n`
  );
  // Alias-smuggled dangerous volume list.
  expectReject(
    "alias-smuggled bind",
    `x-v: &v\n  - /:/host\nservices:\n  a:\n    image: x\n    volumes: *v\n`
  );

  // ---- prewrite: MUST pass --------------------------------------------
  expectPass(
    "plain web+db, relative bind, named volume, ports",
    `services:
  web:
    build: ./web
    ports: ["3000:3000"]
    volumes:
      - ./web:/app
      - ./config/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on: [db]
  db:
    image: postgres:17-alpine
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes:
  pgdata:
`
  );
  expectPass(
    "no-new-privileges hardening is allowed",
    `services:\n  a:\n    image: x\n    security_opt: ["no-new-privileges:true"]\n`
  );
  expectPass(
    "anonymous volume + tmpfs + named volume",
    `services:\n  a:\n    image: x\n    volumes: ["/var/cache"]\n    tmpfs: ["/run"]\n`
  );
  expectPass("empty compose string is deferred elsewhere", `   `);
  // The aquarium/demo scenario: the rewriter attaches subdomain envs to the
  // operator's Traefik proxy network (declared external). MUST pass when
  // that network is the configured/allowed one.
  expectPass(
    "configured proxy network (subdomain routing, default 'proxy') allowed",
    `services:\n  web:\n    image: x\n    networks: [proxy, internal]\nnetworks:\n  proxy:\n    external: true\n  internal: null\n`,
    { allowedExternalNetworks: ["proxy"] }
  );
  expectPass(
    "proxy network reached via name: override allowed",
    `services:\n  web:\n    image: x\n    networks: [edge]\nnetworks:\n  edge:\n    external: true\n    name: proxy\n`,
    { allowedExternalNetworks: ["proxy"] }
  );

  // ---- runtime containment (synthetic resolved model) -----------------
  const root = await mkdtemp(path.join(tmpdir(), "wv-compose-sec-"));
  await mkdir(path.join(root, "data"), { recursive: true });
  // Symlink inside the env dir that points OUT of it — realpath containment
  // must catch this (the classic agent-planted-symlink escape).
  await symlink("/etc", path.join(root, "evil-link"));
  await writeFile(path.join(root, "ok.txt"), "x");

  await expectModelPass(
    "resolved: bind inside env dir",
    {
      services: {
        a: {
          image: "x",
          volumes: [
            { type: "bind", source: path.join(root, "data"), target: "/app" },
          ],
        },
      },
    },
    root
  );
  await expectModelReject(
    "resolved: bind to /etc/passwd (outside)",
    {
      services: {
        a: {
          image: "x",
          volumes: [{ type: "bind", source: "/etc/passwd", target: "/p" }],
        },
      },
    },
    root
  );
  await expectModelReject(
    "resolved: symlink inside env dir escaping to /etc",
    {
      services: {
        a: {
          image: "x",
          volumes: [
            {
              type: "bind",
              source: path.join(root, "evil-link"),
              target: "/etc",
            },
          ],
        },
      },
    },
    root
  );
  await expectModelReject(
    "resolved: privileged still caught post-resolution",
    { services: { a: { image: "x", privileged: true } } },
    root
  );
  await expectModelPass(
    "resolved: named volume + tmpfs",
    {
      services: {
        a: {
          image: "x",
          volumes: [
            { type: "volume", source: "pgdata", target: "/v" },
            { type: "tmpfs", target: "/run" },
          ],
        },
      },
      volumes: { pgdata: {} },
    },
    root
  );
  // Resolved form `docker compose config` emits for the rewriter's proxy
  // network: `{ name, external: true }`. Allowed when it's the proxy net.
  await expectModelPass(
    "resolved: proxy external network allowed (aquarium scenario)",
    {
      services: { web: { image: "x", networks: ["proxy", "internal"] } },
      networks: { proxy: { name: "proxy", external: true }, internal: {} },
    },
    root,
    ["proxy"]
  );
  await expectModelReject(
    "resolved: non-proxy external network still rejected",
    {
      services: { web: { image: "x", networks: ["host_secrets"] } },
      networks: { host_secrets: { name: "host_secrets", external: true } },
    },
    root,
    ["proxy"]
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
