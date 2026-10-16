/**
 * Self-check for the compose → ECS task-definition translator. This repo has
 * no test runner, so (matching the `check:compose-security` convention) this
 * is a ts-node script:
 *
 *   pnpm --filter @withvibe/api check:compose-to-taskdef
 *
 * Focus: the Phase 1 Fargate contract —
 *  - images-only (build: rejected), no host filesystem (bind mounts rejected,
 *    named volumes become ephemeral task volumes)
 *  - containers share a task network namespace, so peer service hostnames in
 *    env values are rewritten to 127.0.0.1
 *  - compose shapes (env list/map, ports variants, healthcheck, depends_on,
 *    ${VAR} interpolation) land in the right task-definition fields
 *
 * Exits non-zero on any unexpected outcome.
 */
import {
  translateComposeToTaskDef,
  ComposeTranslateError,
  interpolate,
  rewriteServiceHosts,
} from "./compose-to-taskdef";

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
function expect(name: string, cond: boolean, detail = "") {
  if (cond) ok(name);
  else bad(name, detail);
}

function translate(
  composeYaml: string,
  dotEnv: Record<string, string> = {},
  repoNames: string[] = []
) {
  return translateComposeToTaskDef({
    composeYaml,
    dotEnv,
    family: "withvibe-test",
    logGroupName: "/withvibe/envs",
    region: "eu-west-1",
    executionRoleArn: "arn:aws:iam::111111111111:role/exec",
    taskRoleArn: "arn:aws:iam::111111111111:role/task",
    repoNames,
  });
}

function rejects(name: string, composeYaml: string, msgPart: string) {
  try {
    translate(composeYaml);
    bad(name, "expected ComposeTranslateError, got success");
  } catch (err) {
    if (err instanceof ComposeTranslateError && err.message.includes(msgPart)) {
      ok(name);
    } else {
      bad(name, `wrong error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ---------- rejection paths --------------------------------------------------

rejects(
  "build: rejected",
  `
services:
  web:
    build: .
`,
  "images-only"
);

rejects(
  "bind mount rejected (short syntax)",
  `
services:
  web:
    image: nginx
    volumes:
      - ./src:/app/src
`,
  "bind-mounts"
);

rejects(
  "bind mount rejected (long syntax)",
  `
services:
  web:
    image: nginx
    volumes:
      - type: bind
        source: /etc
        target: /host-etc
`,
  "bind-mounts"
);

rejects(
  "missing image rejected",
  `
services:
  web:
    command: echo hi
`,
  "no image"
);

rejects("empty compose rejected", `services: {}`, "no services");

// ---------- happy path -------------------------------------------------------

const full = translate(
  `
services:
  web:
    image: ghcr.io/acme/web:\${TAG:-latest}
    ports:
      - "8080:80"
      - 9090
    environment:
      - DATABASE_URL=postgres://user:pass@db:5432/app
      - STATIC=1
    depends_on:
      db:
        condition: service_healthy
    command: npm start
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: \${DB_PASS}
    volumes:
      - dbdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
      interval: 10s
      timeout: 5s
      retries: 3
volumes:
  dbdata:
`,
  { TAG: "v2", DB_PASS: "secret" }
);

const defs = full.taskDefinition.containerDefinitions ?? [];
const web = defs.find((c) => c.name === "web");
const db = defs.find((c) => c.name === "db");

expect("two containers", defs.length === 2);
expect(
  "image interpolated from dotEnv",
  web?.image === "ghcr.io/acme/web:v2",
  String(web?.image)
);
expect(
  "env value interpolated",
  db?.environment?.some((e) => e.name === "POSTGRES_PASSWORD" && e.value === "secret") === true
);
expect(
  "peer hostname rewritten to 127.0.0.1",
  web?.environment?.some(
    (e) =>
      e.name === "DATABASE_URL" &&
      e.value === "postgres://user:pass@127.0.0.1:5432/app"
  ) === true,
  JSON.stringify(web?.environment)
);
expect(
  "untouched env var survives",
  web?.environment?.some((e) => e.name === "STATIC" && e.value === "1") === true
);
expect(
  "ports mapped (target side of HOST:CONTAINER)",
  JSON.stringify(web?.portMappings?.map((p) => p.containerPort)) ===
    JSON.stringify([80, 9090]),
  JSON.stringify(web?.portMappings)
);
expect(
  "servicePorts exposes primary port",
  JSON.stringify(full.servicePorts.web) === JSON.stringify([80, 9090])
);
expect(
  "string command wrapped in sh -c",
  JSON.stringify(web?.command) === JSON.stringify(["sh", "-c", "npm start"])
);
expect(
  "named volume becomes task volume",
  full.taskDefinition.volumes?.some((v) => v.name === "dbdata") === true
);
expect(
  "mountPoint wired",
  db?.mountPoints?.some(
    (m) => m.sourceVolume === "dbdata" && m.containerPath === "/var/lib/postgresql/data"
  ) === true
);
expect(
  "healthcheck mapped",
  JSON.stringify(db?.healthCheck?.command) ===
    JSON.stringify(["CMD-SHELL", "pg_isready"]) &&
    db?.healthCheck?.interval === 10 &&
    db?.healthCheck?.timeout === 5 &&
    db?.healthCheck?.retries === 3,
  JSON.stringify(db?.healthCheck)
);
expect(
  "depends_on service_healthy → HEALTHY",
  web?.dependsOn?.some(
    (d) => d.containerName === "db" && d.condition === "HEALTHY"
  ) === true
);
expect(
  "awslogs config on every container",
  defs.every(
    (c) =>
      c.logConfiguration?.logDriver === "awslogs" &&
      c.logConfiguration.options?.["awslogs-group"] === "/withvibe/envs" &&
      c.logConfiguration.options?.["awslogs-stream-prefix"] === "env"
  )
);
expect(
  "task shape: FARGATE/awsvpc with roles",
  full.taskDefinition.networkMode === "awsvpc" &&
    full.taskDefinition.requiresCompatibilities?.[0] === "FARGATE" &&
    full.taskDefinition.cpu === "1024" &&
    full.taskDefinition.memory === "2048" &&
    full.taskDefinition.executionRoleArn?.endsWith("role/exec") === true
);
expect(
  "hostname rewrite reported in notes",
  full.notes.some((n) => n.includes("DATABASE_URL"))
);

// ---------- x-withvibe sizing ------------------------------------------------

const sized = translate(`
x-withvibe:
  cpu: 2048
  memory: 4096
services:
  web:
    image: nginx
`);
expect(
  "x-withvibe sizing honored",
  sized.taskDefinition.cpu === "2048" && sized.taskDefinition.memory === "4096"
);

rejects(
  "invalid cpu tier rejected",
  `
x-withvibe:
  cpu: 300
services:
  web:
    image: nginx
`,
  "cpu"
);

// ---------- unit helpers -----------------------------------------------------

expect(
  "interpolate: default used when var missing",
  interpolate("img:${TAG:-latest}", {}) === "img:latest"
);
expect(
  "interpolate: var wins over default",
  interpolate("img:${TAG:-latest}", { TAG: "v9" }) === "img:v9"
);
expect(
  "rewriteServiceHosts: bare value on host-like key",
  rewriteServiceHosts("db", ["db"], "DB_HOST") === "127.0.0.1"
);
expect(
  "rewriteServiceHosts: bare value preserved on non-host key",
  rewriteServiceHosts("wordpress", ["wordpress"], "MARIADB_DATABASE") ===
    "wordpress" &&
    rewriteServiceHosts("wordpress", ["wordpress"], "MARIADB_USER") ===
      "wordpress"
);
expect(
  "rewriteServiceHosts: svc:port still rewritten on any key",
  rewriteServiceHosts("db:3306", ["db"], "WORDPRESS_DB_HOST") ===
    "127.0.0.1:3306"
);
expect(
  "rewriteServiceHosts: scheme://svc",
  rewriteServiceHosts("redis://cache:6379/0", ["cache"]) ===
    "redis://127.0.0.1:6379/0"
);
expect(
  "rewriteServiceHosts: svc:port",
  rewriteServiceHosts("cache:6379", ["cache"]) === "127.0.0.1:6379"
);
expect(
  "rewriteServiceHosts: no false positive on substrings",
  rewriteServiceHosts("mydb-service.example.com", ["db"]) ===
    "mydb-service.example.com"
);

// rewriter-shaped service: ports stripped, traefik label carries the target
const rewritten = translate(`
services:
  web:
    image: nginx
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.env-abc123-web.rule=Host(\`web-abc123.example.com\`)"
      - "traefik.http.services.env-abc123-web.loadbalancer.server.port=3000"
    networks: [withvibe-x-edge, internal]
networks:
  withvibe-x-edge:
    external: true
  internal: {}
`);
expect(
  "traefik label port read when ports: stripped",
  JSON.stringify(rewritten.servicePorts.web) === JSON.stringify([3000]),
  JSON.stringify(rewritten.servicePorts)
);

// env_file: ./.env merge
const envFile = translate(
  `
services:
  web:
    image: nginx
    env_file: .env
    environment:
      OVERRIDE: fromCompose
`,
  { FROM_FILE: "yes", OVERRIDE: "fromFile" }
);
const envWeb = envFile.taskDefinition.containerDefinitions?.[0];
expect(
  "env_file .env merged, environment wins",
  envWeb?.environment?.some((e) => e.name === "FROM_FILE" && e.value === "yes") ===
    true &&
    envWeb?.environment?.some(
      (e) => e.name === "OVERRIDE" && e.value === "fromCompose"
    ) === true,
  JSON.stringify(envWeb?.environment)
);

// ---- repository bind mounts ------------------------------------------------
// The one bind source that can be honoured: a path inside a repository the
// task clones for itself. Everything else is still a host path with no sandbox
// equivalent.

const repoMount = translate(
  `
services:
  aquarium:
    image: nginx
    volumes:
      - ./vibe-aquarium:/usr/share/nginx/html:ro
`,
  {},
  ["vibe-aquarium"]
);
const aquarium = repoMount.taskDefinition.containerDefinitions?.[0];
expect(
  "a repo bind mount becomes a task volume",
  repoMount.repoMounts.length === 1 &&
    repoMount.repoMounts[0].repoName === "vibe-aquarium" &&
    repoMount.repoMounts[0].workspacePath === "vibe-aquarium",
  JSON.stringify(repoMount.repoMounts)
);
expect(
  "the container mounts that volume at the compose target",
  aquarium?.mountPoints?.[0]?.sourceVolume === repoMount.repoMounts[0]?.volumeName &&
    aquarium?.mountPoints?.[0]?.containerPath === "/usr/share/nginx/html",
  JSON.stringify(aquarium?.mountPoints)
);
expect(
  ":ro survives the translation",
  aquarium?.mountPoints?.[0]?.readOnly === true,
  JSON.stringify(aquarium?.mountPoints)
);
expect(
  "the repo is reported as required, and its service as waiting",
  JSON.stringify(repoMount.requiredRepos) === JSON.stringify(["vibe-aquarium"]) &&
    JSON.stringify(repoMount.servicesNeedingRepos) === JSON.stringify(["aquarium"]),
  JSON.stringify({
    requiredRepos: repoMount.requiredRepos,
    servicesNeedingRepos: repoMount.servicesNeedingRepos,
  })
);
// A repo mount is NOT a compose named volume: it must not land in the volumes
// the translator declares itself, because only the driver can resolve it to an
// access point. Declaring it here with no efsVolumeConfiguration would quietly
// give the service an empty scratch directory instead of the code.
expect(
  "a repo volume is left for the driver to declare",
  (repoMount.taskDefinition.volumes ?? []).every(
    (v) => v.name !== repoMount.repoMounts[0]?.volumeName
  ),
  JSON.stringify(repoMount.taskDefinition.volumes)
);

const subdir = translate(
  `
services:
  web:
    image: nginx
    volumes:
      - ./app/public:/srv
`,
  {},
  ["app"]
);
expect(
  "a subdirectory of a repo resolves to that subdirectory",
  subdir.repoMounts.length === 1 &&
    subdir.repoMounts[0].repoName === "app" &&
    subdir.repoMounts[0].workspacePath === "app/public",
  JSON.stringify(subdir.repoMounts)
);

const shared = translate(
  `
services:
  web:
    image: nginx
    volumes:
      - ./app:/srv
  worker:
    image: node
    volumes:
      - ./app:/code
`,
  {},
  ["app"]
);
expect(
  "two services mounting the same path share one volume",
  shared.repoMounts.length === 1 &&
    shared.taskDefinition.containerDefinitions?.[0]?.mountPoints?.[0]
      ?.sourceVolume ===
      shared.taskDefinition.containerDefinitions?.[1]?.mountPoints?.[0]
        ?.sourceVolume,
  JSON.stringify(shared.repoMounts)
);
expect(
  "both of them are recorded as waiting on the clone",
  JSON.stringify(shared.servicesNeedingRepos) ===
    JSON.stringify(["web", "worker"]),
  JSON.stringify(shared.servicesNeedingRepos)
);

const twoPaths = translate(
  `
services:
  web:
    image: nginx
    volumes:
      - ./app:/srv
      - ./app/public:/public
`,
  {},
  ["app"]
);
expect(
  "a repo and a subdirectory of it get distinct volumes",
  twoPaths.repoMounts.length === 2 &&
    new Set(twoPaths.repoMounts.map((m) => m.volumeName)).size === 2,
  JSON.stringify(twoPaths.repoMounts)
);

// Rejections. Each names what the user can actually do instead.
const hostPathCompose = (source: string) => `
services:
  web:
    image: nginx
    volumes:
      - ${source}:/srv
`;
rejects(
  "an absolute host path is still refused",
  hostPathCompose("/var/data"),
  "host paths don't exist on Fargate"
);
rejects(
  "a path climbing out of the env is refused",
  hostPathCompose("../secrets"),
  "host paths don't exist on Fargate"
);
rejects(
  "a home-relative path is refused",
  hostPathCompose("~/stuff"),
  "host paths don't exist on Fargate"
);
try {
  translate(hostPathCompose("./not-a-repo"), {}, ["app"]);
  bad("a directory that is not a repo is refused", "expected a rejection");
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  expect(
    "a directory that is not a repo is refused, naming the repos that work",
    err instanceof ComposeTranslateError && msg.includes("./app"),
    msg
  );
}
try {
  translate(hostPathCompose("."), {}, ["app"]);
  bad("a bare . is refused", "expected a rejection");
} catch {
  // "." means the env directory in a template compose and the repository root
  // in one read out of a repo. Guessing between them would silently mount the
  // wrong tree, so it fails instead.
  ok("a bare . is refused rather than guessed at");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
