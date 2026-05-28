import path from "node:path";
import { run } from "../exec.js";
import { log } from "./log.js";
import { readEnvFile, type EnvMap } from "./env-file.js";
import { envPath } from "./paths.js";
import {
  EXTERNAL_IMAGES,
  imagesForFeatures,
  registryName,
  STACK_IMAGES,
  type BuildArgContext,
  type ImageSpec,
} from "./images.js";
import type { InstallState } from "./state.js";

// Derive image-build-time args from the install's .env. Centralized so all
// build entry points (init, configure, upgrade, build-images-cmd) pass the
// same context — keeps `withvibe-code-tunnel` reproducible from .env alone.
export function buildArgContextFromEnv(env: EnvMap): BuildArgContext {
  return {
    codeTunnelAptPackages: env.CODE_TUNNEL_APT_PACKAGES || undefined,
    codeTunnelExtensions: env.CODE_TUNNEL_EXTENSIONS || undefined,
  };
}

export async function readBuildArgContext(
  installDir: string
): Promise<BuildArgContext> {
  const env = await readEnvFile(envPath(installDir));
  return buildArgContextFromEnv(env);
}

export type BuildOptions = {
  // Source tree root. For from-source installs, this is state.source.repoPath.
  repoPath: string;
  features: InstallState["features"];
  // Resolved from the install's .env (see resolveBuildArgContext in
  // build-images-cmd / upgrade / configure). Forwarded to images that
  // declare a `buildArgs` resolver — currently `withvibe-code-tunnel`
  // bakes CODE_TUNNEL_APT_PACKAGES + CODE_TUNNEL_EXTENSIONS into the image
  // so first-tunnel-start doesn't pay the install cost.
  buildArgContext?: BuildArgContext;
};

// Build every stack image enabled by the install's features, locally, in
// place. Streams docker output so the operator can see progress.
export async function buildAllImages(opts: BuildOptions): Promise<void> {
  const images = imagesForFeatures(opts.features);
  log.header(`Building ${images.length} image(s) from source`);
  for (const img of images) {
    await buildOne(img, opts.repoPath, opts.buildArgContext ?? {});
  }
  log.ok("All images built.");
}

async function buildOne(
  img: ImageSpec,
  repoPath: string,
  buildArgContext: BuildArgContext
): Promise<void> {
  const args = ["build", "-t", img.localName];
  if (img.dockerfile) args.push("-f", path.join(repoPath, img.dockerfile));
  const extraArgs = img.buildArgs ? img.buildArgs(buildArgContext) : {};
  for (const [k, v] of Object.entries(extraArgs)) {
    args.push("--build-arg", `${k}=${v}`);
  }
  args.push(path.join(repoPath, img.contextDir));

  log.step(`docker ${args.join(" ")}`);
  const res = await run("docker", args, { streamTo: "inherit" });
  if (res.code !== 0) {
    throw new Error(`docker build failed for ${img.label} (exit ${res.code})`);
  }
  log.ok(`Built ${img.localName}`);
}

export type PullOptions = {
  namespace: string;
  tag: string;
  features: InstallState["features"];
};

// Pull each image from a registry and re-tag it to the local name the api
// expects. We always tag locally as :latest because the api pins to that.
export async function pullAllImages(opts: PullOptions): Promise<void> {
  const images = imagesForFeatures(opts.features);
  log.header(`Pulling ${images.length} image(s) from ${opts.namespace}`);
  for (const img of images) {
    const remote = registryName(img.localName, opts.namespace, opts.tag);
    log.step(`docker pull ${remote}`);
    const pull = await run("docker", ["pull", remote], { streamTo: "inherit" });
    if (pull.code !== 0) {
      throw new Error(`docker pull failed for ${remote} (exit ${pull.code})`);
    }
    if (remote !== img.localName) {
      const tag = await run("docker", ["tag", remote, img.localName]);
      if (tag.code !== 0) {
        throw new Error(`docker tag ${remote} ${img.localName} failed`);
      }
    }
    log.ok(`Tagged as ${img.localName}`);
  }

  // Postgres is referenced by tag in compose; ensure it's local too so
  // `compose up` doesn't surprise-pull on first start.
  log.step(`docker pull ${EXTERNAL_IMAGES.postgres}`);
  await run("docker", ["pull", EXTERNAL_IMAGES.postgres], { streamTo: "inherit" });
}

export type LoadOptions = {
  bundlePath: string; // path to images.tar OR a directory containing it
};

// Load images from an offline bundle (created by scripts/build-bundle.sh).
// Accepts either the .tar directly or the bundle directory.
export async function loadBundleImages(opts: LoadOptions): Promise<void> {
  const tarPath = opts.bundlePath.endsWith(".tar")
    ? opts.bundlePath
    : path.join(opts.bundlePath, "images.tar");
  log.header(`Loading images from ${tarPath}`);
  const res = await run("docker", ["load", "-i", tarPath], { streamTo: "inherit" });
  if (res.code !== 0) {
    throw new Error(`docker load failed (exit ${res.code})`);
  }
  log.ok("Bundle images loaded.");
}

// Check which expected images are present locally. Used by `status` and
// before `compose up` so we can warn before the api crashes on a missing
// sidecar image.
//
// `bundleVersion` (from state.bundle.version) overrides the :latest fallback
// for every withvibe image — both compose (api/web) and the api's sidecar
// spawners resolve the same tag from $WITHVIBE_VERSION at runtime.
export async function imagePresence(
  features: InstallState["features"],
  bundleVersion?: string
): Promise<{ image: string; present: boolean }[]> {
  const expected = imagesForFeatures(features).map((i) =>
    retagToVersion(i.localName, bundleVersion)
  );
  expected.push(EXTERNAL_IMAGES.postgres);
  const out: { image: string; present: boolean }[] = [];
  for (const name of expected) {
    const res = await run("docker", ["image", "inspect", name]);
    out.push({ image: name, present: res.code === 0 });
  }
  return out;
}

function retagToVersion(local: string, version: string | undefined): string {
  if (!version) return local;
  // Replace :latest with the bundle's version tag. All withvibe local names
  // end in :latest (see images.ts).
  if (local.endsWith(":latest")) {
    return `${local.slice(0, -":latest".length)}:${version}`;
  }
  return local;
}

// Convenience: which stack image specs the registry namespace would push to.
// Used by `status` to print the expected remote tags.
export function expectedRemotes(
  namespace: string,
  tag: string,
  features: InstallState["features"]
): string[] {
  return imagesForFeatures(features).map((i) =>
    registryName(i.localName, namespace, tag)
  );
}

// Re-export the spec list so callers don't need to import from two places.
export { STACK_IMAGES };
