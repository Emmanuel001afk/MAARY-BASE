import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Prints an actionable message instead of a Node stack trace. */
function fail(message) {
  process.stderr.write(`APK verification failed: ${message}\n`);
  process.exit(1);
}

// Unexpected parser errors (truncated archives, bad deflate streams) are also
// reported as verification failures rather than as unhandled exceptions.
process.on("uncaughtException", (error) => {
  fail(error instanceof Error ? error.message : String(error));
});

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const requireApksigner = flags.has("--require-apksigner");

const apkPath = resolve(
  args[0] || "android/app/build/outputs/apk/debug/app-debug.apk"
);

if (!existsSync(apkPath)) {
  fail(
    `APK file does not exist: ${apkPath}. Build it with \`npm run android:build\` ` +
      "on a host with a JDK and the Android SDK, or download the CI artifact."
  );
}

const fileStat = statSync(apkPath);
if (!fileStat.isFile() || fileStat.size < 10_240) {
  fail(
    `APK file is empty or unexpectedly small (${fileStat.size} bytes): ${apkPath}. ` +
      "A real Android package is always larger than 10 KB."
  );
}

const buf = readFileSync(apkPath);
if (buf.readUInt32LE(0) !== 0x04034b50) {
  fail(
    `Not a ZIP archive (missing local file header): ${apkPath}. ` +
      "An APK is a ZIP container; this file is something else."
  );
}

let eocdOffset = -1;
const minOffset = Math.max(0, buf.length - 22 - 65_535);
for (let offset = buf.length - 22; offset >= minOffset; offset -= 1) {
  if (
    buf.readUInt32LE(offset) === 0x06054b50 &&
    offset + 22 + buf.readUInt16LE(offset + 20) <= buf.length
  ) {
    eocdOffset = offset;
    break;
  }
}
if (eocdOffset < 0) {
  fail(`Missing ZIP End of Central Directory (EOCD) in ${apkPath}`);
}

const totalEntries = buf.readUInt16LE(eocdOffset + 10);
const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);
const entries = new Map();

let ptr = centralDirOffset;
for (let i = 0; i < totalEntries && ptr + 46 <= eocdOffset; i += 1) {
  if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
  const method = buf.readUInt16LE(ptr + 10);
  const compSize = buf.readUInt32LE(ptr + 20);
  const nameLen = buf.readUInt16LE(ptr + 28);
  const extraLen = buf.readUInt16LE(ptr + 30);
  const commentLen = buf.readUInt16LE(ptr + 32);
  const localOffset = buf.readUInt32LE(ptr + 42);
  const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString("utf8");
  entries.set(name, { method, compSize, localOffset });
  ptr += 46 + nameLen + extraLen + commentLen;
}

function extractEntry(name) {
  const meta = entries.get(name);
  if (!meta) {
    fail(`APK is missing required entry '${name}'`);
  }
  const lNameLen = buf.readUInt16LE(meta.localOffset + 26);
  const lExtraLen = buf.readUInt16LE(meta.localOffset + 28);
  const start = meta.localOffset + 30 + lNameLen + lExtraLen;
  const raw = buf.subarray(start, start + meta.compSize);
  return meta.method === 0 ? raw : inflateRawSync(raw);
}

const manifest = extractEntry("AndroidManifest.xml");
if (manifest.readUInt16LE(0) !== 0x0003) {
  fail("AndroidManifest.xml is not compiled binary AXML (0x0003)");
}

const arsc = extractEntry("resources.arsc");
if (arsc.readUInt16LE(0) !== 0x0002) {
  fail("resources.arsc is not a compiled Android resource table (0x0002)");
}

const dexNames = [...entries.keys()].filter((name) =>
  /^classes\d*\.dex$/.test(name)
);
if (!dexNames.includes("classes.dex")) {
  fail("APK is missing required entry 'classes.dex'");
}

let foundMainActivity = false;
for (const dexName of dexNames) {
  const dex = extractEntry(dexName);
  if (dex.subarray(0, 4).toString("ascii") !== "dex\n") {
    fail(
      `${dexName} does not begin with Dalvik executable magic ('dex\\n')`
    );
  }
  if (dex.includes(Buffer.from("Lcom/marrybase/platform/MainActivity;"))) {
    foundMainActivity = true;
  }
}
if (!foundMainActivity) {
  fail(
    `No DEX entry (${dexNames.join(", ")}) contains compiled MainActivity class`
  );
}

function findApksigner() {
  const exe = process.platform === "win32" ? "apksigner.bat" : "apksigner";
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  for (const root of [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME]) {
    if (!root || !existsSync(join(root, "build-tools"))) continue;
    const versions = readdirSync(join(root, "build-tools")).sort().reverse();
    for (const ver of versions) {
      const candidate = join(root, "build-tools", ver, exe);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const apksigner = findApksigner();
if (apksigner) {
  const cmd = process.platform === "win32" ? "cmd.exe" : apksigner;
  const cmdArgs =
    process.platform === "win32"
      ? ["/c", apksigner, "verify", "--verbose", "--print-certs", apkPath]
      : ["verify", "--verbose", "--print-certs", apkPath];
  const res = spawnSync(cmd, cmdArgs, { encoding: "utf8" });
  if (res.status !== 0) {
    process.stderr.write(res.stdout || "");
    process.stderr.write(res.stderr || "");
    fail(`Android apksigner rejected ${apkPath}`);
  }
  process.stdout.write(res.stdout);
} else if (requireApksigner) {
  fail(
    "apksigner was required (--require-apksigner) but was not found in PATH, " +
      "ANDROID_SDK_ROOT/build-tools or ANDROID_HOME/build-tools. " +
      "Install Android SDK build-tools or unset --require-apksigner."
  );
}

const sha256 = createHash("sha256").update(buf).digest("hex");
console.log(
  JSON.stringify(
    {
      verified: true,
      apkPath,
      sizeBytes: fileStat.size,
      entriesCount: entries.size,
      sha256,
      apksignerVerified: Boolean(apksigner),
    },
    null,
    2
  )
);
