import path from "node:path";
import { promises as fs } from "node:fs";
import {
  buildAllImages,
  loadBundleImages,
  pullAllImages,
  readBuildArgContext,
} from "../build-images.js";
import { log } from "../log.js";
import { DEFAULT_INSTALL_DIR, expandHome } from "../paths.js";
import { readState } from "../state.js";

export type BuildImagesArgs = {
  installDir?: string;
  // Forces a specific path even if state says otherwise. Useful when running
  // build-images from a fresh clone before `init`.
  repoPath?: string;
  bundlePath?: string;
};

export async function runBuildImages(args: BuildImagesArgs): Promise<void> {
  const installDir = args.installDir
    ? path.resolve(expandHome(args.installDir))
    : DEFAULT_INSTALL_DIR;
  const state = await readState(installDir);

  if (!state) {
    log.fail(
      `No install state at ${installDir}. Run \`withvibe init\` first, or pass --repo-path / --bundle-path to override.`
    );
    if (!args.repoPath && !args.bundlePath) process.exit(1);
  }

  const repoPath = args.repoPath
    ? path.resolve(expandHome(args.repoPath))
    : state?.source?.repoPath;
  const bundlePath = args.bundlePath
    ? path.resolve(expandHome(args.bundlePath))
    : state?.bundle?.bundlePath;

  const features =
    state?.features ?? {
      qaBrowser: true,
      codeServer: true,
      traefik: false,
      googleOAuth: false,
    };
  const mode = state?.mode ?? (repoPath ? "from-source" : bundlePath ? "from-bundle" : null);

  if (!mode) {
    log.fail(
      "Cannot determine install mode. Run init or pass --repo-path / --bundle-path."
    );
    process.exit(1);
  }

  if (mode === "from-source") {
    if (!repoPath) {
      log.fail("from-source requires a source tree. Pass --repo-path.");
      process.exit(1);
    }
    await assertDir(repoPath, "Source tree");
    const buildArgContext = await readBuildArgContext(installDir);
    await buildAllImages({ repoPath, features, buildArgContext });
  } else if (mode === "from-bundle") {
    if (!bundlePath) {
      log.fail("from-bundle requires the bundle path. Pass --bundle-path.");
      process.exit(1);
    }
    await loadBundleImages({ bundlePath });
  } else {
    if (!state?.registry) {
      log.fail("from-registry requires registry config in install state.");
      process.exit(1);
    }
    await pullAllImages({
      namespace: state.registry.namespace,
      tag: state.registry.tag,
      features,
    });
  }
}

async function assertDir(p: string, label: string): Promise<void> {
  const stat = await fs.stat(p).catch(() => null);
  if (!stat?.isDirectory()) {
    log.fail(`${label} not found: ${p}`);
    process.exit(1);
  }
}
