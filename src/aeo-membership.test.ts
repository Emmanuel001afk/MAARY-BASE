import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  AEO_FRAMEWORK_AUDIENCE,
  AEO_MEMBERSHIP_TYP,
  AEO_UCCS_PROTOCOL,
  AEO_TRUST_BUNDLE_TYP,
  AEO_TRUST_BUNDLE_AUDIENCE,
  verifyAeoTrustBundle,
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


const rootPair = generateKeyPairSync("ed25519");
const rootPublic = rootPair.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const pinnedRoot = {
  kid: "aeo-root-test-01",
  issuer: "AEO" as const,
  algorithm: "Ed25519" as const,
  publicKey: new Uint8Array(rootPublic),
  notBefore: now - 10_000,
  notAfter: now + 1_000_000,
};
function signedTrustBundle(version = 7) {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = b64({ alg: "EdDSA", typ: AEO_TRUST_BUNDLE_TYP, kid: pinnedRoot.kid });
  const payload = b64({
    iss: "AEO",
    aud: AEO_TRUST_BUNDLE_AUDIENCE,
    bundle_type: "aeo-trust-bundle",
    bundle_version: 1,
    version,
    iat: now - 30,
    nbf: now - 30,
    exp: now + 86_370,
    keys: [{
      kid: key.kid,
      issuer: key.issuer,
      algorithm: "Ed25519",
      publicKey: Buffer.from(rawPublic).toString("base64url"),
      notBefore: now - 10_000,
      notAfter: now + 1_000_000,
    }],
    revokedCredentialIds: [],
  });
  const input = header + "." + payload;
  return input + "." + sign(null, Buffer.from(input, "ascii"), rootPair.privateKey).toString("base64url");
}
test("verifies a root-signed AEO trust bundle", () => {
  const bundle = verifyAeoTrustBundle(signedTrustBundle(), {
    pinnedRootKeys: [pinnedRoot],
    nowSeconds: now,
  });
  assert.equal(bundle.version, 7);
  assert.equal(bundle.trustedKeys[0]?.kid, key.kid);
});
test("rejects trust-bundle rollback and an unpinned root", () => {
  assert.throws(() => verifyAeoTrustBundle(signedTrustBundle(7), {
    pinnedRootKeys: [pinnedRoot], minimumVersion: 8, nowSeconds: now,
  }));
  assert.throws(() => verifyAeoTrustBundle(signedTrustBundle(), {
    pinnedRootKeys: [], nowSeconds: now,
  }));
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
  await assert.rejects(() => verifyAeoMembershipCredential(compact({ ...claims(), exp: now - 120 }), options()));
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


test("accepts the shared AEO cross-platform trust, membership and registration vector", async () => {
  const vector = JSON.parse(readFileSync(new URL("./fixtures/aeo-conformance-vectors-v1.json", import.meta.url), "utf8"));
  const bundle = verifyAeoTrustBundle(vector.trustBundle, {
    pinnedRootKeys: vector.pinnedRootKeys,
    nowSeconds: vector.nowSeconds,
  });
  assert.equal(bundle.version, vector.expected.trustBundleVersion);
  assert.equal(bundle.trustedKeys[0]?.kid, vector.expected.issuerKeyId);
  const options = {
    trustedKeys: bundle.trustedKeys,
    nowSeconds: vector.nowSeconds,
    isCredentialRevoked: async ({ jti }: { issuer: string; jti: string; platformId: string }) =>
      bundle.revokedCredentialIds.includes(jti),
  };
  const membership = await verifyAeoMembershipCredential(vector.membershipCredential, options);
  assert.equal(membership.platformId, vector.expected.membershipPlatformId);
  const registration = await verifyAeoPeerRegistration(vector.registration, options);
  assert.equal(registration.platformId, vector.expected.membershipPlatformId);
});
