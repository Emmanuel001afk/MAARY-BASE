import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const apk = resolve(process.argv[2] || "releases/marry-base.apk");

function fail(message) {
  console.error(`APK verification failed: ${message}`);
  process.exit(1);
}

if (!existsSync(apk)) fail(`${apk} does not exist. Build it with \`npm run android:build\` on a host with a JDK and the Android SDK.`);
if (statSync(apk).size === 0) fail(`${apk} is empty.`);
if (statSync(apk).size < 1024) fail(`${apk} is only ${statSync(apk).size} bytes; that is not a real APK.`);
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
  if (result.error && result.error.code === "ENOENT") {
    fail(
      `\`${command}\` was not found, so the signature could not be checked. ` +
        "Install Android SDK build-tools (which provides apksigner) and set ANDROID_HOME, " +
        "or point APKSIGNER / APKSIGNER_JAR at the tool."
    );
  }
  if (result.error) fail(result.error.message);
  if (result.status !== 0 || !/^Verifies$/m.test(result.stdout)) {
    fail(`apksigner rejected ${apk}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
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
  fail("APK Signature Scheme v2 verification is required");
}
if (/^Number of signers: \d+$/m.test(standard) === false) {
  fail("apksigner did not report a signer");
}

// The companion app targets API 24+, where APK Signature Scheme v2 is
// sufficient. When a v1 JAR signature is present (for example a release signed
// with enableV1Signing), it is verified too; its absence is not a failure.
const modern = verify(command, prefix, ["--min-sdk-version", "24"]);
if (/^Verified using v1 scheme \(JAR signing\): true$/m.test(modern) === false) {
  console.log("No v1/JAR signature present; v2 signing is sufficient for minSdk 24.");
}

console.log(`APK signature verification passed: ${apk}`);
