import { spawnSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import { config } from "../config.js";
import { AppError, NotFoundError, ValidationError } from "../lib/errors.js";
import { recordAuditEvent } from "./audit.service.js";

export type ModuleTruthStatus =
  | "operational_verified"
  | "implemented_unverified"
  | "partially_implemented"
  | "requires_configuration"
  | "unavailable"
  | "failed";

export interface ApkPackageInspection {
  valid: boolean;
  filePath: string;
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  builtAt: string;
  entries: string[];
  hasBinaryManifest: boolean;
  hasResourcesArsc: boolean;
  hasDexBytecode: boolean;
  hasSignatureBlock: boolean;
  error?: string;
}

export interface AndroidEnvironmentStatus {
  status: ModuleTruthStatus;
  summary: string;
  androidProjectPresent: boolean;
  requiredProjectFiles: Array<{ path: string; present: boolean }>;
  toolchain: {
    javaAvailable: boolean;
    gradleAvailable: boolean;
    gradleCommand: string | null;
    androidSdkAvailable: boolean;
    androidSdkRoot: string | null;
    canBuildOnHost: boolean;
  };
  artifact: ApkPackageInspection | null;
  downloadAvailable: boolean;
  downloadUrl: string | null;
  ciWorkflowPath: string;
  ciArtifactName: string;
}

const REQUIRED_ANDROID_FILES = [
  "android/settings.gradle",
  "android/build.gradle",
  "android/app/build.gradle",
  "android/app/src/main/AndroidManifest.xml",
  "android/app/src/main/java/com/marrybase/platform/MainActivity.java",
];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function commandExists(cmd: string, args: string[] = ["-version"]): boolean {
  try {
    const res = spawnSync(cmd, args, {
      stdio: "ignore",
      timeout: 5_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function findZipEocd(buf: Buffer): number {
  const minOffset = Math.max(0, buf.length - 22 - 65_535);
  for (let offset = buf.length - 22; offset >= minOffset; offset -= 1) {
    if (
      buf.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + buf.readUInt16LE(offset + 20) <= buf.length
    ) {
      return offset;
    }
  }
  return -1;
}

export async function verifyApkPackage(
  targetPath: string
): Promise<ApkPackageInspection> {
  const fullPath = resolve(targetPath);
  const fileStat = await stat(fullPath);
  const buf = await readFile(fullPath);
  const checksumSha256 = createHash("sha256").update(buf).digest("hex");

  const baseInfo = {
    filePath: fullPath,
    fileName: basename(fullPath),
    sizeBytes: fileStat.size,
    checksumSha256,
    builtAt: fileStat.mtime.toISOString(),
  };

  if (buf.length < 1024 || buf.readUInt32LE(0) !== 0x04034b50) {
    return {
      ...baseInfo,
      valid: false,
      entries: [],
      hasBinaryManifest: false,
      hasResourcesArsc: false,
      hasDexBytecode: false,
      hasSignatureBlock: false,
      error: "File is not a valid non-empty ZIP/APK archive.",
    };
  }

  const eocdOffset = findZipEocd(buf);
  if (eocdOffset < 0) {
    return {
      ...baseInfo,
      valid: false,
      entries: [],
      hasBinaryManifest: false,
      hasResourcesArsc: false,
      hasDexBytecode: false,
      hasSignatureBlock: false,
      error: "ZIP End of Central Directory (EOCD) record is missing.",
    };
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
  const entries: string[] = [];
  const extractedChecks = new Map<string, Buffer>();

  let ptr = centralDirOffset;
  for (let i = 0; i < totalEntries && ptr + 46 <= eocdOffset; i += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      break;
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const entryName = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
    entries.push(entryName);

    if (
      entryName === "AndroidManifest.xml" ||
      entryName === "resources.arsc" ||
      entryName === "classes.dex"
    ) {
      if (
        localHeaderOffset + 30 <= buf.length &&
        buf.readUInt32LE(localHeaderOffset) === 0x04034b50
      ) {
        const lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
        const lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
        const slice = buf.subarray(dataStart, dataStart + compressedSize);
        try {
          const decoded = method === 0 ? slice : method === 8 ? inflateRawSync(slice) : Buffer.alloc(0);
          extractedChecks.set(entryName, decoded);
        } catch {
          // Corrupt compressed entry
        }
      }
    }

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  const manifestBuf = extractedChecks.get("AndroidManifest.xml");
  const arscBuf = extractedChecks.get("resources.arsc");
  const dexBuf = extractedChecks.get("classes.dex");

  // Binary AXML starts with RES_XML_TYPE = 0x0003
  const hasBinaryManifest = Boolean(
    manifestBuf && manifestBuf.length >= 8 && manifestBuf.readUInt16LE(0) === 0x0003
  );
  // Compiled resource table starts with RES_TABLE_TYPE = 0x0002
  const hasResourcesArsc = Boolean(
    arscBuf && arscBuf.length >= 12 && arscBuf.readUInt16LE(0) === 0x0002
  );
  // Dalvik Executable starts with "dex\n"
  const hasDexBytecode = Boolean(
    dexBuf && dexBuf.length >= 112 && dexBuf.subarray(0, 4).toString("ascii") === "dex\n"
  );

  // Check APK Sig Block v2/v3 magic ("APK Sig Block 42") immediately preceding Central Directory or META-INF signature
  const sigMagicPos = centralDirOffset - 16;
  const hasApkSigBlockV2 =
    sigMagicPos >= 8 &&
    buf.subarray(sigMagicPos, centralDirOffset).toString("ascii") ===
      "APK Sig Block 42";
  const hasMetaInfSig = entries.some(
    (e) =>
      e.startsWith("META-INF/") &&
      (e.endsWith(".RSA") || e.endsWith(".DSA") || e.endsWith(".EC"))
  );
  const hasSignatureBlock = hasApkSigBlockV2 || hasMetaInfSig;

  const valid =
    hasBinaryManifest && hasResourcesArsc && hasDexBytecode && hasSignatureBlock;

  return {
    ...baseInfo,
    valid,
    entries,
    hasBinaryManifest,
    hasResourcesArsc,
    hasDexBytecode,
    hasSignatureBlock,
    ...(valid
      ? {}
      : {
          error:
            "APK package failed structural verification (requires compiled binary AndroidManifest.xml, resources.arsc, classes.dex, and valid signature).",
        }),
  };
}

export function getCandidateApkPaths(projectSlug?: string): string[] {
  const root = process.cwd();
  if (projectSlug) {
    return [
      resolve(root, "releases", `marry-base-${projectSlug}.apk`),
    ];
  }
  const candidates: string[] = [];
  if (config.ANDROID_APK_PATH) {
    candidates.push(resolve(root, config.ANDROID_APK_PATH));
  }
  candidates.push(
    resolve(root, "releases", "marry-base-android.apk"),
    resolve(root, "releases", "marry-base.apk"),
    resolve(root, "android", "app", "build", "outputs", "apk", "release", "app-release.apk"),
    resolve(root, "android", "app", "build", "outputs", "apk", "debug", "app-debug.apk")
  );
  return candidates;
}

export function validateApkSlug(rawSlug?: string): string | undefined {
  if (!rawSlug) return undefined;
  const trimmed = rawSlug.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(trimmed)) {
    throw new ValidationError(
      "Invalid projectSlug: must contain only lowercase letters, digits, and hyphens."
    );
  }
  return trimmed;
}

export function validateApkBuildInputs(input: {
  projectSlug?: string;
  serverUrl?: string;
  versionName?: string;
  versionCode?: number;
}): {
  projectSlug?: string;
  serverUrl?: string;
  versionName: string;
  versionCode: number;
} {
  const projectSlug = validateApkSlug(input.projectSlug);
  const versionName = (input.versionName ?? "1.0.0").trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9._-]+)?$/.test(versionName)) {
    throw new ValidationError(
      "Invalid versionName: expected semantic version format (e.g. 1.0.0)."
    );
  }
  const versionCode = input.versionCode ?? 1;
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > 2_000_000_000) {
    throw new ValidationError(
      "Invalid versionCode: must be a positive integer."
    );
  }

  let serverUrl: string | undefined;
  if (input.serverUrl !== undefined && input.serverUrl !== "") {
    let parsed: URL;
    try {
      parsed = new URL(input.serverUrl.trim());
    } catch {
      throw new ValidationError("Invalid serverUrl: must be a valid HTTP or HTTPS URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ValidationError("Invalid serverUrl: protocol must be http: or https:.");
    }
    if (parsed.username || parsed.password) {
      throw new ValidationError("Invalid serverUrl: embedded credentials are not allowed.");
    }
    serverUrl = parsed.toString().replace(/\/+$/, "");
  }

  return { projectSlug, serverUrl, versionName, versionCode };
}

export async function inspectAndroidEnvironment(
  projectSlug?: string
): Promise<AndroidEnvironmentStatus> {
  const validatedSlug = validateApkSlug(projectSlug);
  const root = process.cwd();

  const requiredProjectFiles = await Promise.all(
    REQUIRED_ANDROID_FILES.map(async (relPath) => ({
      path: relPath,
      present: await fileExists(resolve(root, relPath)),
    }))
  );
  const androidProjectPresent = requiredProjectFiles.every((f) => f.present);

  const gradlewPath = resolve(
    root,
    "android",
    process.platform === "win32" ? "gradlew.bat" : "gradlew"
  );
  const hasGradlew = await fileExists(gradlewPath);
  const hasSystemGradle = commandExists("gradle", ["--version"]);
  const javaAvailable = commandExists("java", ["-version"]);

  const sdkEnv =
    process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || null;
  const androidSdkAvailable = sdkEnv ? await fileExists(sdkEnv) : false;
  const gradleAvailable = hasGradlew || hasSystemGradle;
  const gradleCommand = hasGradlew
    ? gradlewPath
    : hasSystemGradle
      ? "gradle"
      : null;
  const canBuildOnHost =
    androidProjectPresent &&
    javaAvailable &&
    gradleAvailable &&
    androidSdkAvailable;

  let artifact: ApkPackageInspection | null = null;
  for (const candidate of getCandidateApkPaths(validatedSlug)) {
    if (await fileExists(candidate)) {
      artifact = await verifyApkPackage(candidate);
      break;
    }
  }

  let status: ModuleTruthStatus;
  let summary: string;

  if (!androidProjectPresent) {
    status = "failed";
    summary = "Native Android Gradle project files under android/ are incomplete.";
  } else if (artifact && !artifact.valid) {
    status = "failed";
    summary = artifact.error ?? "Found Android APK file failed package verification.";
  } else if (artifact && artifact.valid) {
    status = "operational_verified";
    summary = `Verified Gradle-built Android APK (${artifact.fileName}, ${(artifact.sizeBytes / 1024).toFixed(1)} KB) ready for download.`;
  } else if (canBuildOnHost) {
    status = "implemented_unverified";
    summary =
      "Android Gradle project and host SDK toolchain are ready; run a Gradle build to produce the APK artifact.";
  } else {
    status = "requires_configuration";
    summary =
      "Native Android Gradle source (android/) is present. No prebuilt APK is on disk and host lacks JDK/Gradle/Android SDK — build via GitHub Actions CI ('android' job) or set ANDROID_APK_PATH.";
  }

  const downloadAvailable = Boolean(artifact && artifact.valid);
  const downloadUrl = downloadAvailable
    ? validatedSlug
      ? `/v1/platform/apk/download?projectSlug=${encodeURIComponent(validatedSlug)}`
      : "/v1/platform/apk/download"
    : null;

  return {
    status,
    summary,
    androidProjectPresent,
    requiredProjectFiles,
    toolchain: {
      javaAvailable,
      gradleAvailable,
      gradleCommand,
      androidSdkAvailable,
      androidSdkRoot: sdkEnv,
      canBuildOnHost,
    },
    artifact,
    downloadAvailable,
    downloadUrl,
    ciWorkflowPath: ".github/workflows/ci.yml",
    ciArtifactName: "marry-base-android-apk",
  };
}

export async function readVerifiedApkArtifact(projectSlug?: string): Promise<{
  inspection: ApkPackageInspection;
  buffer: Buffer;
}> {
  const validatedSlug = validateApkSlug(projectSlug);
  for (const candidate of getCandidateApkPaths(validatedSlug)) {
    if (await fileExists(candidate)) {
      const inspection = await verifyApkPackage(candidate);
      if (!inspection.valid) {
        throw new AppError(
          500,
          "invalid_apk_artifact",
          inspection.error ?? "APK artifact failed structural verification."
        );
      }
      const buffer = await readFile(candidate);
      return { inspection, buffer };
    }
  }
  throw new NotFoundError(
    validatedSlug
      ? `No Gradle-built Android APK found for project '${validatedSlug}'. Build it with Gradle or download the CI artifact.`
      : "No Gradle-built Android APK is present on this server yet. Build with Gradle ('npm run build:android') or download the 'marry-base-android-apk' artifact from GitHub Actions CI."
  );
}

export async function buildAndroidApkWithGradle(input: {
  projectSlug?: string;
  serverUrl?: string;
  versionName?: string;
  versionCode?: number;
  buildType?: "debug" | "release";
  actorId?: string | null;
}): Promise<ApkPackageInspection & { downloadUrl: string; packageName: string }> {
  const validated = validateApkBuildInputs(input);
  const env = await inspectAndroidEnvironment();

  if (!env.androidProjectPresent) {
    throw new AppError(
      500,
      "android_project_missing",
      "Android Gradle project files under android/ are missing."
    );
  }

  if (!env.toolchain.canBuildOnHost || !env.toolchain.gradleCommand) {
    const missing: string[] = [];
    if (!env.toolchain.javaAvailable) missing.push("JDK 17+ (java)");
    if (!env.toolchain.gradleAvailable) missing.push("Gradle 8+ (gradle)");
    if (!env.toolchain.androidSdkAvailable) {
      missing.push("Android SDK (ANDROID_SDK_ROOT / ANDROID_HOME)");
    }
    throw new AppError(
      503,
      "android_toolchain_unavailable",
      `Genuine Android Gradle compilation requires ${missing.join(", ")} on this host. Build via GitHub Actions CI (.github/workflows/ci.yml -> 'marry-base-android-apk') or provision the Android SDK.`,
      {
        missingComponents: missing,
        ciWorkflow: env.ciWorkflowPath,
        ciArtifactName: env.ciArtifactName,
      }
    );
  }

  const buildType = input.buildType === "release" ? "Release" : "Debug";
  const taskName = `assemble${buildType}`;
  const args = [
    taskName,
    "--no-daemon",
    `-PmarryBaseVersionName=${validated.versionName}`,
    `-PmarryBaseVersionCode=${validated.versionCode}`,
  ];
  if (validated.serverUrl) {
    args.push(`-PmarryBaseServerUrl=${validated.serverUrl}`);
  }
  if (validated.projectSlug) {
    args.push(`-PmarryBaseProjectSlug=${validated.projectSlug}`);
  }

  const androidDir = resolve(process.cwd(), "android");
  const { exitCode, stdout, stderr } = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolveBuild, rejectBuild) => {
    const child = spawn(env.toolchain.gradleCommand!, args, {
      cwd: androidDir,
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", rejectBuild);
    child.on("close", (code) =>
      resolveBuild({ exitCode: code, stdout: out, stderr: err })
    );
  });

  if (exitCode !== 0) {
    throw new AppError(
      500,
      "gradle_build_failed",
      `Gradle '${taskName}' failed with exit code ${exitCode}.`,
      {
        exitCode,
        stderr: stderr.slice(-4000),
        stdout: stdout.slice(-2000),
      }
    );
  }

  const gradleOutputApk = resolve(
    androidDir,
    "app",
    "build",
    "outputs",
    "apk",
    buildType.toLowerCase(),
    `app-${buildType.toLowerCase()}.apk`
  );

  if (!(await fileExists(gradleOutputApk))) {
    throw new AppError(
      500,
      "gradle_output_missing",
      `Gradle completed '${taskName}' but output APK was not found at ${gradleOutputApk}.`
    );
  }

  const releasesDir = resolve(process.cwd(), "releases");
  await mkdir(releasesDir, { recursive: true });
  const destFileName = validated.projectSlug
    ? `marry-base-${validated.projectSlug}.apk`
    : "marry-base-android.apk";
  const destPath = resolve(releasesDir, destFileName);
  await copyFile(gradleOutputApk, destPath);

  const inspection = await verifyApkPackage(destPath);
  if (!inspection.valid) {
    throw new AppError(
      500,
      "gradle_apk_invalid",
      inspection.error ?? "Compiled APK failed verification."
    );
  }

  await recordAuditEvent({
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId ?? null,
    action: "platform.apk.gradle_built",
    resourceType: "apk",
    resourceId: destFileName,
    metadata: {
      sizeBytes: inspection.sizeBytes,
      checksumSha256: inspection.checksumSha256,
      versionName: validated.versionName,
      versionCode: validated.versionCode,
      projectSlug: validated.projectSlug ?? null,
    },
  });

  const downloadUrl = validated.projectSlug
    ? `/v1/platform/apk/download?projectSlug=${encodeURIComponent(validated.projectSlug)}`
    : "/v1/platform/apk/download";

  return {
    ...inspection,
    packageName: "com.marrybase.platform",
    downloadUrl,
  };
}
