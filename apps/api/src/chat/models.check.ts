/**
 * Guards the hand-sync between `apps/api/src/chat/models.ts` and
 * `apps/web/src/lib/models.ts`.
 *
 * They have to agree in both directions: an id the picker offers but the api
 * rejects saves nothing and looks broken, and an id the api accepts but the
 * picker never shows is dead config. The api list is also the only validator
 * now — `isModelChoice` replaced three separately-maintained copies of the
 * same array (in workspaces.service, envs.service, and models.ts), which had
 * already drifted.
 *
 * Run: pnpm --filter @withvibe/api exec ts-node src/chat/models.check.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { MODEL_OPTIONS } from "./models";

// Read the web list as text rather than importing it — apps/web is a separate
// package with its own tsconfig and path aliases, and pulling it into the api's
// compilation just for this check is more coupling than the check is worth.
const WEB_MODELS = path.resolve(
  __dirname,
  "../../../web/src/lib/models.ts"
);

function webIds(): string[] {
  const source = readFileSync(WEB_MODELS, "utf8");
  const block = source.slice(source.indexOf("MODEL_OPTIONS"));
  return [...block.matchAll(/^\s*id:\s*"([^"]+)"/gm)].map((m) => m[1]!);
}

const apiIds = MODEL_OPTIONS.map((o) => o.id);
const webList = webIds();

const missingInWeb = apiIds.filter((id) => !webList.includes(id));
const missingInApi = webList.filter((id) => !apiIds.includes(id as never));
const orderDiffers =
  missingInWeb.length === 0 &&
  missingInApi.length === 0 &&
  apiIds.join(",") !== webList.join(",");

if (webList.length === 0) {
  console.error(`Parsed no ids out of ${WEB_MODELS} — has the file moved?`);
  process.exit(1);
}

const problems: string[] = [];
if (missingInWeb.length > 0) {
  problems.push(`Offered by the api but missing from the picker: ${missingInWeb.join(", ")}`);
}
if (missingInApi.length > 0) {
  problems.push(`In the picker but rejected by the api: ${missingInApi.join(", ")}`);
}
if (orderDiffers) {
  problems.push(
    `Same ids, different order — the picker renders in list order:\n  api: ${apiIds.join(", ")}\n  web: ${webList.join(", ")}`
  );
}

if (problems.length > 0) {
  console.error("Model lists are out of sync.\n");
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nEdit both: src/chat/models.ts and ${WEB_MODELS}`);
  process.exit(1);
}

console.log(`Model lists agree (${apiIds.length} options): ${apiIds.join(", ")}`);
