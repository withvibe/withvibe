/**
 * Behavioural check for the SAAS_MODE gate. Runs the real service against a
 * stub ConfigService — no DB, no Nest container.
 */
import { SaasModeService } from "./saas-mode.service";

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

function svc(vars: Record<string, string>) {
  const config = { get: (k: string) => vars[k] } as never;
  return new SaasModeService(config);
}

function throws(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const OFF = svc({});
const ON = svc({ SAAS_MODE: "true" });
const ON_ALLOW = svc({
  SAAS_MODE: "true",
  SAAS_LOCAL_WORKSPACE_IDS: " ws-mine , ws-other ",
});

// ---------- mode detection ----------
expect("off by default", OFF.enabled === false);
expect("on when SAAS_MODE=true", ON.enabled === true);
expect(
  "only the literal 'true' enables it",
  svc({ SAAS_MODE: "1" }).enabled === false &&
    svc({ SAAS_MODE: "TRUE" }).enabled === false
);

// ---------- local compute target ----------
expect("local allowed for everyone when off", OFF.localAllowedFor("ws-any"));
expect("local refused for a tenant when on", !ON.localAllowedFor("ws-tenant"));
expect(
  "allowlisted workspace keeps local",
  ON_ALLOW.localAllowedFor("ws-mine") && ON_ALLOW.localAllowedFor("ws-other"),
  "csv should be trimmed"
);
expect(
  "non-allowlisted workspace still refused",
  !ON_ALLOW.localAllowedFor("ws-tenant")
);
expect(
  "empty allowlist means nobody",
  !svc({ SAAS_MODE: "true", SAAS_LOCAL_WORKSPACE_IDS: "" }).localAllowedFor("ws")
);

// ---------- host sidecars ----------
const fargateRefusal = throws(() =>
  OFF.assertHostSidecarAllowed({
    workspaceId: "ws-any",
    computeTarget: "fargate",
    sidecar: "The VS Code tunnel",
  })
);
expect(
  "fargate env refuses host sidecars EVEN WITH SAAS_MODE OFF",
  fargateRefusal !== null,
  "this is the wrong-target case, not a policy case"
);
expect(
  "refusal explains it would run on the platform server",
  (fargateRefusal ?? "").includes("platform server"),
  fargateRefusal ?? "(no throw)"
);

expect(
  "local env + saas off => sidecars fine",
  throws(() =>
    OFF.assertHostSidecarAllowed({
      workspaceId: "ws-any",
      computeTarget: "local",
      sidecar: "code-server",
    })
  ) === null
);
expect(
  "local env + saas on + not allowlisted => refused",
  throws(() =>
    ON.assertHostSidecarAllowed({
      workspaceId: "ws-tenant",
      computeTarget: "local",
      sidecar: "code-server",
    })
  ) !== null
);
expect(
  "local env + saas on + allowlisted => allowed",
  throws(() =>
    ON_ALLOW.assertHostSidecarAllowed({
      workspaceId: "ws-mine",
      computeTarget: "local",
      sidecar: "code-server",
    })
  ) === null
);
expect(
  "allowlist does NOT rescue a fargate env",
  throws(() =>
    ON_ALLOW.assertHostSidecarAllowed({
      workspaceId: "ws-mine",
      computeTarget: "fargate",
      sidecar: "The VS Code tunnel",
    })
  ) !== null,
  "an allowlisted workspace still must not tunnel into a cloud sandbox"
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
