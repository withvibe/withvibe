/**
 * Self-check for the environment spec and its Compose compiler. This repo has
 * no test runner, so (matching check:compose-to-taskdef) this is a ts-node
 * script:
 *
 *   pnpm --filter @withvibe/api check:env-spec
 *
 * Two things carry the weight here. First, the spec is a CLOSED vocabulary —
 * if an unknown key is quietly ignored instead of rejected, the escapes we are
 * trying to make inexpressible become expressible again. Second, the compiler
 * owns the local-vs-Fargate hostname difference, which is the exact thing that
 * previously corrupted a database name.
 *
 * Exits non-zero on any unexpected outcome.
 */
import { parse } from "yaml";
import { parseEnvSpec, EnvSpecError, sizeToMiB } from "./env-spec";
import { compileToCompose } from "./compile-to-compose";
import { translateComposeToTaskDef } from "../compute/fargate/compose-to-taskdef";

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Deterministic secrets so compiled output is comparable. */
const secret = (service: string, purpose: string) => `s3cr3t-${service}-${purpose}`;

function compile(spec: unknown, target: "local" | "fargate" = "local") {
  return compileToCompose(parseEnvSpec(spec), { target, secret });
}

function rejects(name: string, spec: unknown, needle: string) {
  try {
    parseEnvSpec(spec);
    bad(name, "expected EnvSpecError, got success");
  } catch (err) {
    if (err instanceof EnvSpecError && err.message.includes(needle)) {
      pass++;
      console.log(`  ok  ${name}`);
    } else {
      bad(name, `wrong error: ${err instanceof Error ? err.message : err}`);
    }
  }
}
function bad(name: string, detail: string) {
  fail++;
  console.log(`FAIL  ${name} — ${detail}`);
}

// ---------- the closed vocabulary ------------------------------------------
// Each of these is an escape we found in a tenant-authored Compose file. The
// point is not that they are blocked; it is that there is nowhere to put them.

rejects(
  "unknown service key is rejected, not ignored",
  { services: { web: { image: "nginx", volumes: ["/var/run/docker.sock:/x"] } } },
  'unknown key "volumes"'
);
rejects(
  "no slot for Traefik labels (hostname hijack)",
  { services: { web: { image: "nginx", labels: ["traefik.http.routers.x.rule=Host(`app`)"] } } },
  'unknown key "labels"'
);
rejects(
  "no slot for joining an external network",
  { services: { web: { image: "nginx", networks: ["withvibe"] } } },
  'unknown key "networks"'
);
rejects(
  "no slot for privileged",
  { services: { web: { image: "nginx", privileged: true } } },
  'unknown key "privileged"'
);
rejects(
  "unknown top-level key is rejected",
  { services: { web: { image: "nginx" } }, "x-withvibe": { cpu: 4096 } },
  "unknown top-level key"
);

// ---------- basic validation ------------------------------------------------

rejects("a service needs image or type", { services: { web: {} } }, 'needs "image" or "type"');
rejects(
  "image and type are mutually exclusive",
  { services: { web: { image: "nginx", type: "postgres" } } },
  "not both"
);
rejects("unknown managed type", { services: { db: { type: "oracle" } } }, 'unknown type "oracle"');
rejects("services cannot be empty", { services: {} }, "at least one service");
rejects(
  "service names must be DNS-safe",
  { services: { "Web_1": { image: "nginx" } } },
  "lowercase letters"
);
rejects(
  "only one service may own the public URL",
  {
    services: {
      a: { image: "nginx", http: 80 },
      b: { image: "nginx", http: 80 },
    },
  },
  'only one service may set "http"'
);
rejects(
  "storage must be a size",
  { services: { db: { type: "postgres", storage: "lots" } } },
  "storage must look like"
);
rejects(
  "a ref to an unknown service fails at parse time",
  { services: { web: { image: "nginx", env: { H: "{{ nope.host }}" } } } },
  'references unknown service "nope"'
);
rejects(
  "a ref to an unknown field fails at parse time",
  { services: { db: { type: "postgres" }, web: { image: "nginx", env: { H: "{{ db.secret }}" } } } },
  'unknown field "secret"'
);
rejects(
  "all problems are reported together, not just the first",
  { services: { web: { image: "nginx", http: 99999, storage: "big" } } },
  "http must be a port"
);

{
  let problems: string[] = [];
  try {
    parseEnvSpec({ services: { web: { image: "nginx", http: 99999, storage: "big" } } });
  } catch (e) {
    problems = e instanceof EnvSpecError ? e.problems : [];
  }
  expect(
    "…and that list really does contain both problems",
    problems.length === 2,
    JSON.stringify(problems)
  );
}

// ---------- the WordPress template, as a spec -------------------------------

const WORDPRESS = {
  name: "WordPress demo",
  services: {
    web: {
      image: "wordpress:php8.3-apache",
      http: 80,
      env: {
        WORDPRESS_DB_HOST: "{{ db.host }}:{{ db.port }}",
        WORDPRESS_DB_USER: "{{ db.user }}",
        WORDPRESS_DB_PASSWORD: "{{ db.password }}",
        WORDPRESS_DB_NAME: "{{ db.database }}",
      },
    },
    db: { type: "mariadb", version: "11", storage: "2Gi", database: "wordpress" },
  },
};

{
  const r = compile(WORDPRESS, "local");
  const doc = parse(r.composeYaml);
  expect(
    "managed type resolves to a real image",
    doc.services.db.image === "mariadb:11",
    doc.services.db.image
  );
  expect(
    "the engine's own credential env is generated",
    doc.services.db.environment.MARIADB_DATABASE === "wordpress" &&
      doc.services.db.environment.MARIADB_PASSWORD === "s3cr3t-db-password" &&
      doc.services.db.environment.MARIADB_ROOT_PASSWORD === "s3cr3t-db-root-password",
    JSON.stringify(doc.services.db.environment)
  );
  expect(
    "LOCAL: a peer is addressed by service name",
    doc.services.web.environment.WORDPRESS_DB_HOST === "db:3306",
    doc.services.web.environment.WORDPRESS_DB_HOST
  );
  expect(
    "the password crosses services without the user typing it",
    doc.services.web.environment.WORDPRESS_DB_PASSWORD === "s3cr3t-db-password"
  );
  expect(
    "a literal value that happens to equal a service name is untouched",
    // The bug this replaces: `MARIADB_DATABASE: wordpress` was rewritten to
    // 127.0.0.1 because a service was also called "wordpress".
    doc.services.web.environment.WORDPRESS_DB_NAME === "wordpress"
  );
  expect(
    "http becomes a container port, never a host port",
    JSON.stringify(doc.services.web.ports) === JSON.stringify(["80"]),
    JSON.stringify(doc.services.web.ports)
  );
  expect(
    "the public service is reported back",
    r.httpService?.name === "web" && r.httpService.port === 80
  );
  expect(
    "storage becomes a named volume at the engine's data path",
    JSON.stringify(doc.services.db.volumes) ===
      JSON.stringify(["db-data:/var/lib/mysql"]) && "db-data" in doc.volumes,
    JSON.stringify(doc.services.db.volumes)
  );
  expect(
    "depends_on is derived from the references",
    JSON.stringify(doc.services.web.depends_on) === JSON.stringify(["db"])
  );
  expect(
    "every service gets a resource ceiling even though none asked for one",
    doc.services.web.deploy.resources.limits.memory === "512m" &&
      doc.services.db.deploy.resources.limits.cpus === "0.5",
    JSON.stringify(doc.services.web.deploy)
  );
}

// ---------- the target difference -------------------------------------------

{
  const r = compile(WORDPRESS, "fargate");
  const doc = parse(r.composeYaml);
  expect(
    "FARGATE: a peer is addressed on loopback",
    doc.services.web.environment.WORDPRESS_DB_HOST === "127.0.0.1:3306",
    doc.services.web.environment.WORDPRESS_DB_HOST
  );
  expect(
    "FARGATE: the literal database name is STILL untouched",
    doc.services.web.environment.WORDPRESS_DB_NAME === "wordpress",
    doc.services.web.environment.WORDPRESS_DB_NAME
  );
  expect(
    "FARGATE: task sizing is emitted for the translator",
    doc["x-withvibe"].cpu === 1024 && doc["x-withvibe"].memory === 2048,
    JSON.stringify(doc["x-withvibe"])
  );
  expect(
    "FARGATE: ephemeral storage is called out rather than silently lost",
    r.notes.some((n) => n.includes("discarded when the environment stops")),
    JSON.stringify(r.notes)
  );
}

// ---------- url refs --------------------------------------------------------

{
  const r = compile({
    services: {
      cache: { type: "redis" },
      pg: { type: "postgres" },
      app: {
        image: "node:20",
        env: { REDIS_URL: "{{ cache.url }}", DATABASE_URL: "{{ pg.url }}" },
      },
    },
  });
  const doc = parse(r.composeYaml);
  expect(
    "a credential-less engine yields a bare url",
    doc.services.app.environment.REDIS_URL === "redis://cache:6379",
    doc.services.app.environment.REDIS_URL
  );
  expect(
    "a credentialed engine yields a full dsn",
    doc.services.app.environment.DATABASE_URL ===
      "postgresql://app:s3cr3t-pg-password@pg:5432/app",
    doc.services.app.environment.DATABASE_URL
  );
  expect(
    "postgres defaults to a sane image",
    doc.services.pg.image === "postgres:17-alpine",
    doc.services.pg.image
  );
  expect(
    "defaulted versions are reported, not hidden",
    r.notes.some((n) => n.includes("version defaulted to 17"))
  );
}

// ---------- sizing helper ---------------------------------------------------

expect("sizeToMiB: Gi", sizeToMiB("2Gi") === 2048);
expect("sizeToMiB: Mi", sizeToMiB("512Mi") === 512);

{
  const r = compile(
    {
      services: {
        a: { image: "nginx", cpu: 2, memory: "4Gi" },
        b: { image: "nginx", cpu: 1, memory: "2Gi" },
      },
    },
    "fargate"
  );
  const doc = parse(r.composeYaml);
  expect(
    "task sizing rounds up to a tier Fargate actually sells",
    doc["x-withvibe"].cpu === 4096 && doc["x-withvibe"].memory === 8192,
    JSON.stringify(doc["x-withvibe"])
  );
}

// ---------- it has to survive the EXISTING pipeline -------------------------
// The spec is only additive if what it emits is ordinary Compose that the
// Fargate translator already understands. If this breaks, the spec is a second
// format rather than a front end for the first one.

{
  const r = compile(WORDPRESS, "fargate");
  const translated = translateComposeToTaskDef({
    composeYaml: r.composeYaml,
    dotEnv: {},
    family: "withvibe-spec-check",
    logGroupName: "/withvibe/envs",
    region: "eu-west-1",
    executionRoleArn: "arn:aws:iam::111111111111:role/exec",
    taskRoleArn: "arn:aws:iam::111111111111:role/task",
  });
  const defs = translated.taskDefinition.containerDefinitions ?? [];
  const web = defs.find((c) => c.name === "web");
  const db = defs.find((c) => c.name === "db");
  expect(
    "compiled output translates to a task definition",
    defs.length === 2 && !!web && !!db
  );
  expect(
    "the translator picks up the compiled task sizing",
    translated.taskDefinition.cpu === "1024" &&
      translated.taskDefinition.memory === "2048",
    `${translated.taskDefinition.cpu}/${translated.taskDefinition.memory}`
  );
  expect(
    "the http port survives into the task definition",
    JSON.stringify(translated.servicePorts.web) === JSON.stringify([80]),
    JSON.stringify(translated.servicePorts)
  );
  expect(
    "the loopback host written by the compiler is left alone by the translator",
    web?.environment?.some(
      (e) => e.name === "WORDPRESS_DB_HOST" && e.value === "127.0.0.1:3306"
    ) === true,
    JSON.stringify(web?.environment)
  );
  expect(
    "and the database NAME still survives both passes",
    web?.environment?.some(
      (e) => e.name === "WORDPRESS_DB_NAME" && e.value === "wordpress"
    ) === true,
    JSON.stringify(web?.environment)
  );
  expect(
    "the named volume becomes a task volume",
    translated.taskDefinition.volumes?.some((v) => v.name === "db-data") === true
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
