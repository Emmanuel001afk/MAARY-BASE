import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  AEO_FRAMEWORK_AUDIENCE,
  AEO_MEMBERSHIP_TYP,
  AEO_UCCS_PROTOCOL,
  verifyAeoMembershipCredential,
  verifyAeoPeerRegistration,
  type AeoTrustedIssuerKey,
} from "./services/aeo-membership.service.js";

const now = 1_800_000_000;
const pair = generateKeyPairSync("ed25519");
const rawPublic = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const key: AeoTrustedIssuerKey = {
  kid: "aeo-test-issuer-01",
  issuer: "https://identity.aeo.example",
  algorithm: "Ed25519",
  publicKey: new Uint8Array(rawPublic),
  notBefore: now - 10_000,
  notAfter: now + 1_000_000,
};
const claims = (): Record<string, unknown> => ({
  iss: key.issuer,
  aud: AEO_FRAMEWORK_AUDIENCE,
  ecosystem: "AEO",
  credential_type: "aeo-membership",
  credential_version: 1,
  sub: "com.mari.base",
  platform: { id: "com.mari.base", name: "MARI BASE" },
  publisher: { id: "com.aeo.platforms", key_id: "mari-test-key" },
  scope: ["member"],
  jti: "7f4e8c1a-4b8d-4c5a-9e2d-2f7a8b9c0d1e",
  iat: now - 60,
  nbf: now - 60,
  exp: now + 86_340,
});
function compact(payload = claims()) {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64({ alg: "EdDSA", typ: AEO_MEMBERSHIP_TYP, kid: key.kid });
  const body = b64(payload);
  const input = `${header}.${body}`;
  return `${input}.${sign(null, Buffer.from(input, "ascii"), pair.privateKey).toString("base64url")}`;
}
const options = (revoked = false, trustedKeys: AeoTrustedIssuerKey[] = [key]) => ({
  trustedKeys,
  isCredentialRevoked: async () => revoked,
  nowSeconds: now,
});

test("accepts valid AEO membership credentials", async () => {
  const result = await verifyAeoMembershipCredential(compact(), options());
  assert.equal(result.valid, true);
  assert.equal(result.platformId, "com.mari.base");
});

test("rejects signature tampering", async () => {
  const token = compact();
  const parts = token.split(".");
  const signature = Buffer.from(parts[2]!, "base64url");
  signature[0] = signature[0]! ^ 1;
  parts[2] = signature.toString("base64url");
  await assert.rejects(() => verifyAeoMembershipCredential(parts.join("."), options()));
});

test("rejects unknown issuer key", async () => {
  await assert.rejects(() => verifyAeoMembershipCredential(compact(), options(false, [])));
});

test("fails closed when revocation status is positive", async () => {
  await assert.rejects(() => verifyAeoMembershipCredential(compact(), options(true)));
});

test("rejects wrong audience", async () => {
  await assert.rejects(() => verifyAeoMembershipCredential(compact({ ...claims(), aud: "urn:wrong" }), options()));
});

test("rejects expired credentials", async () => {
  await assert.rejects(() => verifyAeoMembershipCredential(compact({ ...claims(), exp: now - 10 }), options()));
});

test("verifies registration and binds the signed platform identity", async () => {
  const registration = {
    ecosystem: "AEO" as const,
    protocol: AEO_UCCS_PROTOCOL,
    platformId: "com.mari.base",
    displayName: "MARI BASE",
    membershipCredential: compact(),
  };
  const result = await verifyAeoPeerRegistration(registration, options());
  assert.equal(result.platformId, "com.mari.base");
  await assert.rejects(() => verifyAeoPeerRegistration(
    { ...registration, displayName: "Different Platform" }, options(),
  ));
});
