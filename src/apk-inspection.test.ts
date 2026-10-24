import assert from "node:assert/strict";
import test from "node:test";
import { inspectApkBuffer } from "./services/apk.service.js";

/**
 * Builds a ZIP archive in memory so the APK inspector can be tested without a
 * signed package on disk. Entries are stored uncompressed; the structure is a
 * real local-header/central-directory/EOCD layout.
 */
function buildArchive(
  files: Array<{ name: string; data: Buffer }>,
  options: { signingBlockMagicEndsAtCentralDirectory?: boolean } = {}
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, file.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + file.data.length;
  }

  const body = Buffer.concat(locals);
  const centralDirectory = Buffer.concat(centrals);

  let signingBlock = Buffer.alloc(0);
  let signingBlockLength = 0;
  if (options.signingBlockMagicEndsAtCentralDirectory) {
    // [pairs][size (8)][magic (16)] — the footer ends where the CD starts.
    const pairs = Buffer.alloc(8, 0);
    const footerSize = Buffer.alloc(8);
    const size = 8 + pairs.length + 8 + 16;
    footerSize.writeBigUInt64LE(BigInt(size), 0);
    signingBlock = Buffer.concat([
      footerSize,
      pairs,
      footerSize,
      Buffer.from("APK Sig Block 42", "ascii"),
    ]);
    signingBlockLength = signingBlock.length;
  }

  const cdOffset = body.length + signingBlockLength;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([body, signingBlock, centralDirectory, eocd]);
}

let crcTable: number[] | null = null;
function crc32(data: Buffer): number {
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function files(
  overrides: { includeDex?: boolean; includeArsc?: boolean; includeRes?: boolean } = {}
) {
  const list = [
    { name: "AndroidManifest.xml", data: Buffer.from("\u0003\u0000\u0008\u0000binary-manifest", "utf8") },
    { name: "META-INF/com/android/build/gradle/app-metadata.properties", data: Buffer.from("appMetadataVersion=1.1") },
  ];
  if (overrides.includeDex !== false) list.push({ name: "classes.dex", data: Buffer.from("dex\n035\u0000code") });
  if (overrides.includeArsc !== false) list.push({ name: "resources.arsc", data: Buffer.from("resource-table") });
  if (overrides.includeRes !== false) list.push({ name: "res/xml/network_security_config.xml", data: Buffer.from("<x/>") });
  return list;
}

test("a v2/v3 signed APK whose block footer ends at the central directory is accepted", () => {
  const buffer = buildArchive(files(), { signingBlockMagicEndsAtCentralDirectory: true });
  const inspection = inspectApkBuffer(buffer);
  assert.deepEqual(inspection.problems, []);
  assert.equal(inspection.hasApkSigningBlock, true);
  assert.ok(inspection.entries.includes("AndroidManifest.xml"));
  assert.ok(inspection.entries.includes("classes.dex"));
});

test("a package with no signature evidence is rejected", () => {
  const inspection = inspectApkBuffer(buildArchive(files()));
  assert.equal(inspection.hasApkSigningBlock, false);
  assert.ok(
    inspection.problems.some((problem) => problem.includes("No APK signature evidence")),
    JSON.stringify(inspection.problems)
  );
});

test("v1 JAR signing evidence is accepted for older packages", () => {
  const inspection = inspectApkBuffer(
    buildArchive([...files(), { name: "META-INF/CERT.RSA", data: Buffer.from("signature") }])
  );
  assert.equal(inspection.hasApkSigningBlock, false);
  assert.deepEqual(inspection.problems, []);
});

test("missing application code, resources, or a corrupt archive is reported", () => {
  const noDex = inspectApkBuffer(
    buildArchive(files({ includeDex: false }), { signingBlockMagicEndsAtCentralDirectory: true })
  );
  assert.ok(noDex.problems.some((problem) => problem.includes("classes.dex")));

  const noResources = inspectApkBuffer(
    buildArchive(files({ includeArsc: false, includeRes: false }), {
      signingBlockMagicEndsAtCentralDirectory: true,
    })
  );
  assert.ok(noResources.problems.some((problem) => problem.includes("resources")));

  const corrupt = inspectApkBuffer(Buffer.from("this is not an android package", "utf8"));
  assert.ok(corrupt.problems.length > 0);
  assert.equal(corrupt.entries.length, 0);
});
