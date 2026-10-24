import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { config } from "../config.js";
import { AppError, NotFoundError } from "../lib/errors.js";
import { recordAuditEvent } from "./audit.service.js";

/**
 * Android artifact management.
 *
 * MARRY BASE does not synthesise Android packages. The companion APK is built by
 * a real Gradle/AGP pipeline (`android/gradlew :app:assembleDebug`, also run in
 * CI) and this service reports on, verifies and serves the resulting artifact.
 * When no artifact exists or the Android SDK is unavailable, the API says so
 * explicitly instead of producing a placeholder file.
 */

export type ApkState = "available" | "missing" | "invalid";

export interface ApkArtifactInfo {
  state: ApkState;
  fileName: string;
  filePath: string;
  sizeBytes: number | null;
  checksumSha256: string | null;
  builtAt: string | null;
  versionName: string | null;
  versionCode: number | null;
  builder: string | null;
}

export interface ApkVerification {
  zipParsed: boolean;
  entries: string[];
  hasAndroidManifest: boolean;
  hasClassesDex: boolean;
  hasResources: boolean;
  hasApkSigningBlock: boolean;
  /** Null when apksigner is not installed; never guessed. */
  apkSignerVerified: boolean | null;
  apkSignerDetail: string | null;
  checkedAt: string;
  problems: string[];
}

export interface ApkBuildEnvironment {
  projectDirectory: string;
  gradlewPresent: boolean;
  javaAvailable: boolean;
  javaVersion: string | null;
  androidSdkPath: string | null;
  androidSdkAvailable: boolean;
  gradleBuildPossible: boolean;
  missingPrerequisites: string[];
  instructions: string;
}

export interface ApkStatus {
  platformName: "MARRY BASE";
  packageName: string;
  state: ApkState;
  statusLabel:
    | "available"
    | "not_built"
    | "invalid_artifact"
    | "build_available";
  summary: string;
  artifact: ApkArtifactInfo;
  verification: ApkVerification | null;
  buildEnvironment: ApkBuildEnvironment;
  downloadUrl: string | null;
  expectedOutputPath: string;
}

const PACKAGE_NAME = "com.marrybase.platform";

function artifactPath(): string {
  return resolve(process.cwd(), config.APK_ARTIFACT_PATH);
}

function metadataPath(): string {
  return resolve(process.cwd(), config.APK_METADATA_PATH);
}

function gradleOutputPath(): string {
  return resolve(
    process.cwd(),
    config.ANDROID_PROJECT_DIR,
    "app",
    "build",
    "outputs",
    "apk",
    "debug",
    "app-debug.apk"
  );
}

/**
 * Parses the ZIP central directory of an APK. This is read-only inspection for
 * verification (entry list, signing block detection) — it never writes packages.
 */
export function inspectApkBuffer(buffer: Buffer): {
  entries: string[];
  problems: string[];
  hasApkSigningBlock: boolean;
} {
  const problems: string[] = [];
  const entries: string[] = [];
  let hasApkSigningBlock = false;

  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    return {
      entries,
      problems: ["The file is not a ZIP archive (missing local file header)."],
      hasApkSigningBlock: false,
    };
  }

  // Locate End of Central Directory (EOCD) record.
  let eocd = -1;
  const searchStart = Math.max(0, buffer.length - 65_557);
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    return {
      entries,
      problems: ["ZIP end-of-central-directory record not found."],
      hasApkSigningBlock: false,
    };
  }

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset >= buffer.length) {
    return {
      entries,
      problems: ["ZIP central directory offset is out of range."],
      hasApkSigningBlock: false,
    };
  }

  let position = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) {
      problems.push("ZIP central directory is truncated or malformed.");
      break;
    }
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const name = buffer
      .subarray(position + 46, position + 46 + nameLength)
      .toString("utf8");
    entries.push(name);
    position += 46 + nameLength + extraLength + commentLength;
  }

  if (entries.length === 0) {
    problems.push("The archive contains no entries.");
  }
  if (!entries.includes("AndroidManifest.xml")) {
    problems.push("AndroidManifest.xml is missing.");
  }
  if (!entries.includes("classes.dex")) {
    problems.push("classes.dex is missing (no compiled application code).");
  }
  if (!entries.some((entry) => entry === "resources.arsc" || entry.startsWith("res/"))) {
    problems.push("No compiled resources are packaged.");
  }

  // APK Signature Scheme v1 (JAR) evidence, and v2 block ("APK Sig Block 42")
  // located immediately before the central directory.
  const sigBlockMagic = Buffer.from("APK Sig Block 42", "ascii");
  const searchFloor = Math.max(0, centralOffset - 262_144);
  for (let i = centralOffset - 20; i >= searchFloor; i--) {
    if (buffer.subarray(i, i + 16).equals(sigBlockMagic)) {
      hasApkSigningBlock = true;
      break;
    }
  }
  if (!hasApkSigningBlock && !entries.some((entry) => entry.startsWith("META-INF/") && /\.(RSA|DSA|EC)$/i.test(entry))) {
    problems.push("No APK signature evidence was found (v1 JAR or v2 signing block).");
  }

  return { entries, problems, hasApkSigningBlock };
}

async function readMetadata(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(metadataPath(), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function checkApkArtifact(): Promise<{
  artifact: ApkArtifactInfo;
  verification: ApkVerification | null;
}> {
  const path = artifactPath();
  const fileName = config.APK_ARTIFACT_PATH.split("/").pop() || "marry-base.apk";
  const metadata = await readMetadata();
  try {
    const stats = await stat(path);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error("empty");
    }
    const buffer = await readFile(path);
    const checksumSha256 = createHash("sha256").update(buffer).digest("hex");
    const inspection = inspectApkBuffer(buffer);
    const verification: ApkVerification = {
      zipParsed: inspection.entries.length > 0,
      entries: inspection.entries,
      hasAndroidManifest: inspection.entries.includes("AndroidManifest.xml"),
      hasClassesDex: inspection.entries.includes("classes.dex"),
      hasResources: inspection.entries.some(
        (entry) => entry === "resources.arsc" || entry.startsWith("res/")
      ),
      hasApkSigningBlock: inspection.hasApkSigningBlock,
      apkSignerVerified: null,
      apkSignerDetail: "Not checked in this environment. CI runs Android apksigner.",
      checkedAt: new Date().toISOString(),
      problems: inspection.problems,
    };
    return {
      verification,
      artifact: {
        state: inspection.problems.length === 0 ? "available" : "invalid",
        fileName,
        filePath: path,
        sizeBytes: stats.size,
        checksumSha256,
        builtAt: typeof metadata?.builtAt === "string" ? metadata.builtAt : stats.mtime.toISOString(),
        versionName: typeof metadata?.versionName === "string" ? metadata.versionName : null,
        versionCode: typeof metadata?.versionCode === "number" ? metadata.versionCode : null,
        builder: typeof metadata?.builder === "string" ? metadata.builder : null,
      },
    };
  } catch {
    return {
      artifact: {
        state: "missing",
        fileName,
        filePath: path,
        sizeBytes: null,
        checksumSha256: null,
        builtAt: null,
        versionName: null,
        versionCode: null,
        builder: null,
      },
      verification: null,
    };
  }
}

async function commandVersion(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise(null);
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0 ? output.trim().split("\n")[0] || null : null);
    });
  });
}

async function readSdkFromLocalProperties(): Promise<string | null> {
  try {
    const raw = await readFile(
      resolve(process.cwd(), config.ANDROID_PROJECT_DIR, "local.properties"),
      "utf8"
    );
    const match = raw.match(/^sdk\.dir=(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function getApkBuildEnvironment(): Promise<ApkBuildEnvironment> {
  const projectDirectory = resolve(process.cwd(), config.ANDROID_PROJECT_DIR);
  const gradlewPath = resolve(projectDirectory, "gradlew");
  const gradlewPresent = existsSync(gradlewPath);

  const javaVersion = await commandVersion(config.JAVA_BIN, ["-version"]);
  const sdk =
    process.env.ANDROID_HOME ||
    process.env.ANDROID_SDK_ROOT ||
    (await readSdkFromLocalProperties()) ||
    null;
  const sdkAvailable = Boolean(sdk && existsSync(sdk));
  const platformAvailable = Boolean(
    sdk && (existsSync(resolve(sdk, "platforms", "android-34")) || existsSync(resolve(sdk, "platforms")))
  );

  const missing: string[] = [];
  if (!gradlewPresent) missing.push("Android Gradle wrapper (android/gradlew)");
  if (!javaVersion) missing.push("Java 17+ (JAVA_BIN or PATH)");
  if (!sdkAvailable) missing.push("Android SDK (ANDROID_HOME or android/local.properties sdk.dir)");
  else if (!platformAvailable) missing.push("Android platform 34 in the SDK");

  return {
    projectDirectory,
    gradlewPresent,
    javaAvailable: Boolean(javaVersion),
    javaVersion,
    androidSdkPath: sdk,
    androidSdkAvailable: sdkAvailable && platformAvailable,
    gradleBuildPossible: missing.length === 0,
    missingPrerequisites: missing,
    instructions:
      "Install JDK 17 and the Android SDK (cmdline-tools + platform 34 + build-tools), " +
      "set ANDROID_HOME, then run `npm run android:build`. CI builds the same artifact with " +
      "`./gradlew :app:assembleDebug` and publishes it as a workflow artifact.",
  };
}

export async function getApkStatus(): Promise<ApkStatus> {
  const { artifact, verification } = await checkApkArtifact();
  const environment = await getApkBuildEnvironment();
  const state = artifact.state;
  let statusLabel: ApkStatus["statusLabel"];
  let summary: string;

  if (state === "available") {
    statusLabel = "available";
    summary = `Android artifact passed structural verification (${artifact.sizeBytes} bytes, SHA-256 ${artifact.checksumSha256?.slice(0, 16)}…). Signature verification requires Android apksigner and is performed by CI after every build.`;
  } else if (state === "invalid") {
    statusLabel = "invalid_artifact";
    summary = `An APK artifact exists but failed structural verification: ${verification?.problems.join(" ")} Replace it with a Gradle-built package.`;
  } else if (environment.gradleBuildPossible) {
    statusLabel = "build_available";
    summary =
      "No APK artifact is present. The Android SDK and Gradle wrapper are available, so `npm run android:build` can produce one.";
  } else {
    statusLabel = "not_built";
    summary =
      "No APK artifact is present and this host cannot run a Gradle build. Build it in CI or on a workstation with the Android SDK, then place the artifact at " +
      config.APK_ARTIFACT_PATH +
      ".";
  }

  return {
    platformName: "MARRY BASE",
    packageName: PACKAGE_NAME,
    state,
    statusLabel,
    summary,
    artifact,
    verification,
    buildEnvironment: environment,
    downloadUrl: state === "available" ? "/v1/platform/apk/download" : null,
    expectedOutputPath: gradleOutputPath(),
  };
}

export interface ApkBuildOptions {
  versionName?: string;
  versionCode?: number;
  actorId?: string | null;
}

export interface ApkBuildResult {
  artifact: ApkArtifactInfo;
  verification: ApkVerification;
  logTail: string[];
  durationMs: number;
}

/**
 * Runs the genuine Gradle build. Fails loudly when prerequisites are missing;
 * there is no fallback that fabricates an APK.
 */
export async function buildApkWithGradle(
  options: ApkBuildOptions = {}
): Promise<ApkBuildResult> {
  const environment = await getApkBuildEnvironment();
  if (!environment.gradleBuildPossible) {
    await recordAuditEvent({
      actorType: "user",
      actorId: options.actorId ?? null,
      action: "apk.build.unavailable",
      resourceType: "android_apk",
      metadata: { missing: environment.missingPrerequisites },
    }).catch(() => undefined);
    throw new AppError(
      409,
      "apk_build_unavailable",
      "This host cannot run a Gradle build for the Android companion app.",
      {
        missingPrerequisites: environment.missingPrerequisites,
        instructions: environment.instructions,
        androidSdkPath: environment.androidSdkPath,
        javaVersion: environment.javaVersion,
      }
    );
  }

  const versionName = options.versionName ?? config.APP_VERSION;
  const versionCode = options.versionCode ?? 1;
  const startedAt = Date.now();
  const logTail: string[] = [];
  const pushLine = (line: string) => {
    const trimmed = line.replace(/\s+$/, "");
    if (!trimmed) return;
    logTail.push(trimmed);
    if (logTail.length > 400) logTail.shift();
  };

  const args = [
    ":app:assembleDebug",
    "--no-daemon",
    `-PmarryVersionName=${versionName}`,
    `-PmarryVersionCode=${versionCode}`,
  ];

  const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn(resolve(environment.projectDirectory, "gradlew"), args, {
      cwd: environment.projectDirectory,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      pushLine(`Build exceeded ${config.APK_BUILD_TIMEOUT_MS} ms and was stopped.`);
    }, config.APK_BUILD_TIMEOUT_MS);

    const consume = (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) pushLine(line);
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(code ?? 1);
    });
  });

  if (exitCode !== 0) {
    await recordAuditEvent({
      actorType: "user",
      actorId: options.actorId ?? null,
      action: "apk.build.failed",
      resourceType: "android_apk",
      metadata: { exitCode, versionName, versionCode },
    }).catch(() => undefined);
    throw new AppError(500, "apk_build_failed", "The Gradle build failed. See the build log for details.", {
      exitCode,
      durationMs: Date.now() - startedAt,
      logTail: logTail.slice(-80),
    });
  }

  const produced = gradleOutputPath();
  let buffer: Buffer;
  try {
    buffer = await readFile(produced);
  } catch {
    throw new AppError(500, "apk_build_failed", "Gradle reported success but no APK was produced.", {
      expectedPath: produced,
      logTail: logTail.slice(-40),
    });
  }
  if (buffer.length === 0) {
    throw new AppError(500, "apk_build_failed", "Gradle produced an empty APK file.", {
      expectedPath: produced,
    });
  }

  await mkdir(dirname(artifactPath()), { recursive: true });
  await copyFile(produced, artifactPath());
  await writeFile(
    metadataPath(),
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        builder: "gradle",
        versionName,
        versionCode,
        source: produced,
        nodeVersion: process.version,
      },
      null,
      2
    )
  );

  const { artifact, verification } = await checkApkArtifact();
  if (artifact.state !== "available" || !verification) {
    throw new AppError(500, "apk_build_invalid", "The built APK failed structural verification.", {
      problems: verification?.problems ?? [],
    });
  }

  await recordAuditEvent({
    actorType: "user",
    actorId: options.actorId ?? null,
    action: "apk.build.succeeded",
    resourceType: "android_apk",
    metadata: { versionName, versionCode, checksumSha256: artifact.checksumSha256 },
  }).catch(() => undefined);

  return { artifact, verification, logTail: logTail.slice(-120), durationMs: Date.now() - startedAt };
}

export async function loadApkForDownload(): Promise<{ buffer: Buffer; info: ApkArtifactInfo }> {
  const { artifact } = await checkApkArtifact();
  if (artifact.state !== "available") {
    throw new NotFoundError(
      artifact.state === "missing"
        ? "No Android APK has been built for this instance yet. Run `npm run android:build` or use the CI workflow artifact."
        : "The APK artifact on this instance failed verification. Rebuild it with `npm run android:build`."
    );
  }
  const buffer = await readFile(artifact.filePath);
  return { buffer, info: artifact };
}

