import { existsSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { config } from "../config.js";

/**
 * Gives a test file its own copy of the APK artifact.
 *
 * Test files run concurrently, and several suites need to observe — and in one
 * case deliberately corrupt — the artifact the server serves. Without an
 * isolated copy those suites race each other and, in CI, mutate the APK that
 * the Gradle job just produced and uploaded. The real artifact is copied in (so
 * the "available" path is exercised in CI) and the working path is redirected to
 * a temporary directory.
 */
export async function isolateApkArtifact(): Promise<() => Promise<void>> {
  const originalArtifact = config.APK_ARTIFACT_PATH;
  const originalMetadata = config.APK_METADATA_PATH;
  const sourceArtifact = resolve(process.cwd(), originalArtifact);
  const sourceMetadata = resolve(process.cwd(), originalMetadata);
  const directory = await mkdtemp(join(tmpdir(), "marry-base-apk-"));
  const artifact = join(directory, "marry-base.apk");
  const metadata = join(directory, "marry-base.apk.json");

  if (existsSync(sourceArtifact)) {
    await copyFile(sourceArtifact, artifact);
    if (existsSync(sourceMetadata)) await copyFile(sourceMetadata, metadata);
  }

  config.APK_ARTIFACT_PATH = artifact;
  config.APK_METADATA_PATH = metadata;

  return async () => {
    config.APK_ARTIFACT_PATH = originalArtifact;
    config.APK_METADATA_PATH = originalMetadata;
    await rm(directory, { recursive: true, force: true });
  };
}
