import assert from "node:assert/strict";
import { createHash, createVerify, X509Certificate } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { buildMarryBaseApk } from "./services/apk.service.js";

function lengthPrefixed(buffer: Buffer, offset: number) {
  assert.ok(offset + 4 <= buffer.length, "Missing length-prefixed value");
  const length = buffer.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + length;
  assert.ok(end <= buffer.length, "Length-prefixed value exceeds its container");
  return { data: buffer.subarray(start, end), offset: end };
}

function onlyLengthPrefixed(buffer: Buffer): Buffer {
  const value = lengthPrefixed(buffer, 0);
  assert.equal(value.offset, buffer.length, "Unexpected trailing signed data");
  return value.data;
}

function verifyApkV2(apk: Buffer): Buffer {
  const eocdOffset = apk.length - 22;
  assert.equal(apk.readUInt32LE(eocdOffset), 0x06054b50);
  assert.equal(apk.readUInt16LE(eocdOffset + 20), 0, "Unexpected ZIP comment");
  const centralDirectoryOffset = apk.readUInt32LE(eocdOffset + 16);
  const footerOffset = centralDirectoryOffset - 24;
  assert.equal(
    apk.subarray(footerOffset + 8, centralDirectoryOffset).toString("ascii"),
    "APK Sig Block 42"
  );
  const blockSize = Number(apk.readBigUInt64LE(footerOffset));
  const blockStart = centralDirectoryOffset - blockSize - 8;
  assert.ok(blockStart >= 8);
  assert.equal(Number(apk.readBigUInt64LE(blockStart)), blockSize);

  let v2Value: Buffer | null = null;
  let pairOffset = blockStart + 8;
  while (pairOffset < footerOffset) {
    const pairLength = Number(apk.readBigUInt64LE(pairOffset));
    const pairEnd = pairOffset + 8 + pairLength;
    assert.ok(pairLength >= 4 && pairEnd <= footerOffset);
    if (apk.readUInt32LE(pairOffset + 8) === 0x7109871a) {
      v2Value = apk.subarray(pairOffset + 12, pairEnd);
    }
    pairOffset = pairEnd;
  }
  assert.ok(v2Value, "APK Signature Scheme v2 block is missing");
  assert.equal(pairOffset, footerOffset);

  const signers = onlyLengthPrefixed(v2Value);
  const signer = onlyLengthPrefixed(signers);
  const signedDataField = lengthPrefixed(signer, 0);
  const signaturesField = lengthPrefixed(signer, signedDataField.offset);
  const publicKeyField = lengthPrefixed(signer, signaturesField.offset);
  assert.equal(publicKeyField.offset, signer.length);
  const signedData = signedDataField.data;

  const digestsField = lengthPrefixed(signedData, 0);
  const certificatesField = lengthPrefixed(signedData, digestsField.offset);
  const attributesField = lengthPrefixed(signedData, certificatesField.offset);
  assert.equal(attributesField.offset, signedData.length);
  assert.equal(attributesField.data.length, 0);

  const digestRecord = onlyLengthPrefixed(digestsField.data);
  assert.equal(digestRecord.readUInt32LE(0), 0x0103, "Expected SHA-256 RSA digest");
  const expectedDigest = lengthPrefixed(digestRecord, 4);
  assert.equal(expectedDigest.offset, digestRecord.length);
  const certificateDer = onlyLengthPrefixed(certificatesField.data);
  const signatureRecord = onlyLengthPrefixed(signaturesField.data);
  assert.equal(signatureRecord.readUInt32LE(0), 0x0103, "Expected SHA-256 RSA signature");
  const signature = lengthPrefixed(signatureRecord, 4);
  assert.equal(signature.offset, signatureRecord.length);

  const certificate = new X509Certificate(certificateDer);
  const certificatePublicKey = certificate.publicKey.export({
    type: "spki",
    format: "der",
  }) as Buffer;
  assert.ok(publicKeyField.data.equals(certificatePublicKey));
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signedData);
  verifier.end();
  assert.ok(
    verifier.verify(certificate.publicKey, signature.data),
    "The v2 signer signature is invalid"
  );

  const digestEocd = Buffer.from(apk.subarray(eocdOffset));
  digestEocd.writeUInt32LE(blockStart, 16);
  const chunkDigests: Buffer[] = [];
  for (const section of [
    apk.subarray(0, blockStart),
    apk.subarray(centralDirectoryOffset, eocdOffset),
    digestEocd,
  ]) {
    for (let offset = 0; offset < section.length; offset += 1024 * 1024) {
      const chunk = section.subarray(offset, offset + 1024 * 1024);
      const prefix = Buffer.alloc(5);
      prefix[0] = 0xa5;
      prefix.writeUInt32LE(chunk.length, 1);
      chunkDigests.push(createHash("sha256").update(prefix).update(chunk).digest());
    }
  }
  const digestPrefix = Buffer.alloc(5);
  digestPrefix[0] = 0x5a;
  digestPrefix.writeUInt32LE(chunkDigests.length, 1);
  const actualDigest = createHash("sha256")
    .update(digestPrefix)
    .update(Buffer.concat(chunkDigests))
    .digest();
  assert.ok(
    actualDigest.equals(expectedDigest.data),
    "APK content digest does not match the signed v2 digest"
  );
  return certificateDer;
}

test("APK v2 signatures cover the whole artifact and retain a stable signing identity", async () => {
  const first = await buildMarryBaseApk({
    projectSlug: "v2-signing-check-a",
    versionCode: 1,
  });
  const second = await buildMarryBaseApk({
    projectSlug: "v2-signing-check-b",
    versionCode: 2,
  });
  try {
    const [firstApk, secondApk] = await Promise.all([
      readFile(first.filePath),
      readFile(second.filePath),
    ]);
    const firstCertificate = verifyApkV2(firstApk);
    const secondCertificate = verifyApkV2(secondApk);
    assert.ok(
      firstCertificate.equals(secondCertificate),
      "Separate builds must reuse the persisted signing certificate"
    );

    const tampered = Buffer.from(firstApk);
    tampered[100] = tampered[100]! ^ 0x01;
    assert.throws(() => verifyApkV2(tampered), /content digest/);
  } finally {
    await Promise.all([
      rm(first.filePath, { force: true }),
      rm(second.filePath, { force: true }),
    ]);
  }
});
