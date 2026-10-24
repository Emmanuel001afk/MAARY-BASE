import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve(process.cwd(), "scripts/verify-apk.mjs");

function run(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("verify-apk reports a missing artifact as a clean failure", () => {
  const result = run([join(tmpdir(), "definitely-not-a-real.apk")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /APK verification failed: APK file does not exist/);
  assert.match(result.stderr, /npm run android:build/);
  // A stack trace would mean an unhandled exception leaked out.
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("verify-apk rejects an implausibly small file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verify-apk-small-"));
  try {
    const file = join(directory, "tiny.apk");
    await writeFile(file, Buffer.from("not-an-android-package"));
    const result = run([file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unexpectedly small \(22 bytes\)/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verify-apk rejects a large file that is not a ZIP archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verify-apk-notzip-"));
  try {
    const file = join(directory, "not-a-zip.apk");
    await writeFile(file, Buffer.alloc(64 * 1024, 0x7a));
    const result = run([file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing local file header/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verify-apk explains an unavailable apksigner when it is required", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verify-apk-signer-"));
  try {
    const file = join(directory, "truncated.apk");
    // A ZIP header followed by garbage: passes the size and magic checks, then
    // fails on the missing end-of-central-directory record.
    const buffer = Buffer.alloc(32 * 1024, 0);
    buffer.writeUInt32LE(0x04034b50, 0);
    await writeFile(file, buffer);
    const result = run([file, "--require-apksigner"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /APK verification failed: Missing ZIP End of Central Directory/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
