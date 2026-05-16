import { build, context } from "esbuild";
import { copyFile, mkdir, rm, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "dist");
const watch = process.argv.includes("--watch");
// `node build.mjs --package` also emits a Chrome Web Store-uploadable zip
// of dist/ next to it.
const pkg = process.argv.includes("--package");

const entries = {
  background: "src/background.ts",
  popup: "src/popup.ts",
};

// Flat assets copied to dist/<basename>.
const staticAssets = ["manifest.json", "src/popup.html"];
// Store-required icons — kept under dist/icons/ so the manifest's
// "icons/iconNN.png" paths resolve in the packed extension.
const iconSizes = [16, 32, 48, 128];

async function clean() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
}

async function copyStatic() {
  for (const rel of staticAssets) {
    await copyFile(path.join(here, rel), path.join(outDir, path.basename(rel)));
  }
  await mkdir(path.join(outDir, "icons"), { recursive: true });
  for (const s of iconSizes) {
    await copyFile(
      path.join(here, "icons", `icon${s}.png`),
      path.join(outDir, "icons", `icon${s}.png`)
    );
  }
}

// Zip dist/ with paths relative to dist/ (the manifest must sit at the zip
// root for the Web Store). Uses the system `zip`; fails loudly if absent so
// the build doesn't silently ship without a package.
function packageZip() {
  const zipPath = path.join(here, "withvibe-qa-browser-extension.zip");
  rmSyncQuiet(zipPath);
  try {
    execFileSync("zip", ["-qr", zipPath, "."], { cwd: outDir });
  } catch (err) {
    console.error(
      `[package] could not create zip — is the \`zip\` CLI installed? (${err.message})`
    );
    process.exit(1);
  }
  console.log(`packaged → ${zipPath}`);
}

function rmSyncQuiet(p) {
  try {
    execFileSync("rm", ["-f", p]);
  } catch {
    /* best-effort */
  }
}

const buildOpts = {
  entryPoints: Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [k, path.join(here, v)])
  ),
  outdir: outDir,
  bundle: true,
  format: "esm",
  target: "chrome120",
  platform: "browser",
  // Source maps are dev-only noise in a store submission and inflate the
  // package; skip them when packaging.
  sourcemap: !pkg,
  logLevel: "info",
};

await clean();
await copyStatic();

if (watch) {
  const ctx = await context(buildOpts);
  await ctx.watch();
  console.log(`watching for changes…`);
} else {
  await build(buildOpts);
  // Touch readdir so the unused-import guard is satisfied and to surface a
  // clear error if the output dir somehow didn't materialize.
  const produced = await readdir(outDir);
  console.log(`built extension → ${outDir} (${produced.length} files)`);
  if (pkg) {
    packageZip();
  } else {
    console.log(
      `load in Chrome: chrome://extensions → enable Developer mode → "Load unpacked" → select ${outDir}`
    );
  }
}
