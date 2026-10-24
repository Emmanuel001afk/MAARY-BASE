import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const apk = resolve(process.argv[2] || "releases/marry-base.apk");
const executableName = process.platform === "win32" ? "apksigner.bat" : "apksigner";

function findApksigner() {
  if (process.env.APKSIGNER) return process.env.APKSIGNER;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) return executableName;
  const buildTools = resolve(sdk, "build-tools");
  let versions;
  try {
    versions = readdirSync(buildTools, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch {
    return executableName;
  }
  return versions.length
    ? resolve(buildTools, versions.at(-1), executableName)
    : executableName;
}

function verify(command, prefix, extraArgs = []) {
  const result = spawnSync(
    command,
    [...prefix, "verify", "--verbose", "--print-certs", ...extraArgs, apk],
    { encoding: "utf8", shell: process.platform === "win32" }
  );
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.error) throw result.error;
  if (result.status !== 0 || !/^Verifies$/m.test(result.stdout)) {
    throw new Error(`Android apksigner rejected ${apk}`);
  }
  return result.stdout;
}

let command;
let prefix;
if (process.env.APKSIGNER_JAR) {
  command = process.env.JAVA || "java";
  prefix = ["-jar", resolve(process.env.APKSIGNER_JAR)];
} else {
  command = findApksigner();
  prefix = [];
}

const standard = verify(command, prefix);
if (!/^Verified using v2 scheme \(APK Signature Scheme v2\): true$/m.test(standard)) {
  throw new Error("APK Signature Scheme v2 verification is required");
}

// The application supports API 24+, where v2 is sufficient. Also exercise the
// retained JAR signature at API 23 so a broken v1 block cannot go unnoticed.
const legacy = verify(command, prefix, ["--min-sdk-version", "23"]);
if (!/^Verified using v1 scheme \(JAR signing\): true$/m.test(legacy)) {
  throw new Error("The retained APK v1/JAR signature did not verify");
}

console.log(`APK signature verification passed: ${apk}`);
