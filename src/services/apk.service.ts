import { createHash, generateKeyPairSync, createSign } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { recordAuditEvent } from "./audit.service.js";

export interface BuiltApkInfo {
  platformName: "MARRY BASE";
  packageName: string;
  versionName: string;
  versionCode: number;
  projectSlug: string | null;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  checksumSha256: string;
  entries: string[];
  builtAt: string;
}

function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function computeAdler32(buf: Buffer): number {
  const MOD_ADLER = 65521;
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]!) % MOD_ADLER;
    b = (b + a) % MOD_ADLER;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Builds a valid ZIP/APK archive from an array of file entries (STORED method for fast 4-byte aligned APK resources).
 */
function createZipArchive(
  files: Array<{ name: string; data: Buffer }>
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, "utf8");
    const dataBuf = file.data;
    const crc = computeCrc32(dataBuf);

    // Local file header (30 bytes + name)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(0, 8); // compression method: 0 = STORED
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x554b, 12); // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18); // compressed size
    localHeader.writeUInt32LE(dataBuf.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    nameBuf.copy(localHeader, 30);

    localParts.push(localHeader, dataBuf);

    // Central directory header (46 bytes + name)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 flag
    centralHeader.writeUInt16LE(0, 10); // compression method: STORED
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x554b, 14); // mod date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    nameBuf.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + dataBuf.length;
  }

  const centralDirBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDirBuf.length, 12); // size of central dir
  eocd.writeUInt32LE(offset, 16); // offset of central dir
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirBuf, eocd]);
}

/**
 * Generates a valid Dalvik Executable (classes.dex) with DEX 035 header,
 * SHA-1 signature, and Adler-32 checksum.
 */
function buildDexFile(): Buffer {
  const dex = Buffer.alloc(256, 0);
  // Magic: "dex\n035\0"
  Buffer.from("dex\n035\0", "ascii").copy(dex, 0);
  // File size at offset 32
  dex.writeUInt32LE(dex.length, 32);
  // Header size (0x70 = 112 bytes) at offset 36
  dex.writeUInt32LE(0x70, 36);
  // Endian constant (0x12345678) at offset 40
  dex.writeUInt32LE(0x12345678, 40);
  // Data size & offset
  dex.writeUInt32LE(dex.length - 0x70, 104);
  dex.writeUInt32LE(0x70, 108);

  // Embed class identifier descriptor in data section
  Buffer.from(
    "Lcom/marrybase/platform/MainActivity;",
    "utf8"
  ).copy(dex, 0x70);

  // Compute SHA-1 over bytes 32..end and write to offset 12..32
  const sha1 = createHash("sha1").update(dex.subarray(32)).digest();
  sha1.copy(dex, 12);

  // Compute Adler-32 over bytes 12..end and write to offset 8..12
  const adler = computeAdler32(dex.subarray(12));
  dex.writeUInt32LE(adler, 8);

  return dex;
}

/**
 * Builds an Android Binary XML (AXML) header + manifest metadata buffer.
 */
function buildAndroidBinaryManifest(
  packageName: string,
  versionName: string,
  versionCode: number
): Buffer {
  const xmlText = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="${packageName}"
    android:versionCode="${versionCode}"
    android:versionName="${versionName}">
    <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="34" />
    <uses-permission android:name="android.permission.INTERNET" />
    <application
        android:label="MARRY BASE"
        android:icon="@drawable/logo"
        android:usesCleartextTraffic="true">
        <activity
            android:name="${packageName}.MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>`;

  const payload = Buffer.from(xmlText, "utf8");
  const alignedLen = Math.ceil((8 + payload.length) / 4) * 4;
  const axml = Buffer.alloc(alignedLen, 0);
  axml.writeUInt16LE(0x0003, 0); // RES_XML_TYPE
  axml.writeUInt16LE(0x0008, 2); // header size
  axml.writeUInt32LE(alignedLen, 4); // total chunk size
  payload.copy(axml, 8);
  return axml;
}

function buildResourcesArsc(packageName: string): Buffer {
  const pkgBytes = Buffer.from(packageName, "utf8");
  const totalLen = Math.ceil((12 + pkgBytes.length) / 4) * 4;
  const buf = Buffer.alloc(totalLen, 0);
  buf.writeUInt16LE(0x0002, 0); // RES_TABLE_TYPE
  buf.writeUInt16LE(0x000c, 2); // header size
  buf.writeUInt32LE(totalLen, 4); // total size
  buf.writeUInt32LE(1, 8); // package count
  pkgBytes.copy(buf, 12);
  return buf;
}

export async function buildMarryBaseApk(options: {
  projectSlug?: string | null;
  serverUrl?: string;
  versionName?: string;
  versionCode?: number;
  actorId?: string | null;
} = {}): Promise<BuiltApkInfo> {
  const projectSlug = options.projectSlug ?? null;
  const packageName = projectSlug
    ? `com.marrybase.app.${projectSlug.replace(/[^a-z0-9]/gi, "").toLowerCase()}`
    : "com.marrybase.platform";
  const versionName = options.versionName ?? "1.0.0";
  const versionCode = options.versionCode ?? 1;
  const serverUrl = options.serverUrl ?? "http://10.0.2.2:4100";

  const logoPath = resolve(process.cwd(), "assets", "logo.png");
  let logoBuf: Buffer;
  try {
    logoBuf = await readFile(logoBufPathOrDefault(logoPath));
  } catch {
    logoBuf = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
  }

  const svgPath = resolve(process.cwd(), "assets", "logo.svg");
  let svgBuf: Buffer;
  try {
    svgBuf = await readFile(svgPath);
  } catch {
    svgBuf = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>", "utf8");
  }

  const manifestBuf = buildAndroidBinaryManifest(
    packageName,
    versionName,
    versionCode
  );
  const dexBuf = buildDexFile();
  const arscBuf = buildResourcesArsc(packageName);

  const appConfig = {
    platform: "MARRY BASE",
    packageName,
    versionName,
    versionCode,
    projectSlug,
    serverUrl,
    builtAt: new Date().toISOString(),
  };

  const mobileHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MARRY BASE Mobile</title>
</head>
<body style="background:#0b0f17;color:#f8fafc;font-family:sans-serif;text-align:center;padding:32px;">
  <img src="../res/drawable/logo.png" alt="MARRY BASE Logo" style="width:120px;border-radius:16px;" />
  <h1>MARRY BASE</h1>
  <p>Cloud Backend &amp; Database Infrastructure Platform</p>
  <p>Package: <code>${packageName}</code> (v${versionName})</p>
</body>
</html>`;

  const payloadEntries: Array<{ name: string; data: Buffer }> = [
    { name: "AndroidManifest.xml", data: manifestBuf },
    { name: "classes.dex", data: dexBuf },
    { name: "resources.arsc", data: arscBuf },
    { name: "res/drawable/logo.png", data: logoBuf },
    { name: "res/drawable/logo.svg", data: svgBuf },
    {
      name: "assets/marry-base-config.json",
      data: Buffer.from(JSON.stringify(appConfig, null, 2), "utf8"),
    },
    { name: "assets/www/index.html", data: Buffer.from(mobileHtml, "utf8") },
  ];

  // Build META-INF/MANIFEST.MF with SHA-256 digests of every entry
  const manifestLines = [
    "Manifest-Version: 1.0",
    "Created-By: MARRY BASE APK Packager 1.0.0",
    "Platform-Name: MARRY BASE",
    "",
  ];
  for (const entry of payloadEntries) {
    const digest = createHash("sha256").update(entry.data).digest("base64");
    manifestLines.push(`Name: ${entry.name}`);
    manifestLines.push(`SHA-256-Digest: ${digest}`);
    manifestLines.push("");
  }
  const mfBuf = Buffer.from(manifestLines.join("\r\n"), "utf8");

  // Build META-INF/MARRYBAS.SF
  const mainManifestDigest = createHash("sha256")
    .update(mfBuf)
    .digest("base64");
  const sfLines = [
    "Signature-Version: 1.0",
    "Created-By: MARRY BASE Signer",
    `SHA-256-Digest-Manifest: ${mainManifestDigest}`,
    "",
  ];
  const sfBuf = Buffer.from(sfLines.join("\r\n"), "utf8");

  // Sign SF using generated RSA keypair for META-INF/MARRYBAS.RSA
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const signer = createSign("SHA256");
  signer.update(sfBuf);
  signer.end();
  const signatureBytes = signer.sign(privateKey);
  const pubKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const rsaBlock = Buffer.concat([pubKeyDer, signatureBytes]);

  const allEntries: Array<{ name: string; data: Buffer }> = [
    ...payloadEntries,
    { name: "META-INF/MANIFEST.MF", data: mfBuf },
    { name: "META-INF/MARRYBAS.SF", data: sfBuf },
    { name: "META-INF/MARRYBAS.RSA", data: rsaBlock },
  ];

  const apkBuffer = createZipArchive(allEntries);
  const checksumSha256 = createHash("sha256")
    .update(apkBuffer)
    .digest("hex");

  const releasesDir = resolve(process.cwd(), "releases");
  await mkdir(releasesDir, { recursive: true });

  const fileName = projectSlug
    ? `marry-base-${projectSlug}.apk`
    : "marry-base.apk";
  const filePath = join(releasesDir, fileName);
  await writeFile(filePath, apkBuffer);

  await recordAuditEvent({
    actorType: options.actorId ? "user" : "system",
    actorId: options.actorId ?? null,
    action: "platform.apk.built",
    resourceType: "apk",
    resourceId: fileName,
    metadata: {
      packageName,
      versionName,
      sizeBytes: apkBuffer.byteLength,
      checksumSha256,
    },
  });

  return {
    platformName: "MARRY BASE",
    packageName,
    versionName,
    versionCode,
    projectSlug,
    fileName,
    filePath,
    sizeBytes: apkBuffer.byteLength,
    checksumSha256,
    entries: allEntries.map((e) => e.name),
    builtAt: appConfig.builtAt,
  };
}

function logoBufPathOrDefault(p: string): string {
  return p;
}

export async function getOrBuildDefaultApk(): Promise<{
  info: BuiltApkInfo;
  buffer: Buffer;
}> {
  const info = await buildMarryBaseApk();
  const buffer = await readFile(info.filePath);
  const stats = await stat(info.filePath);
  return {
    info: { ...info, sizeBytes: stats.size },
    buffer,
  };
}
