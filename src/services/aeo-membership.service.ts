import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

export const AEO_UCCS_PROTOCOL = "uccs/1" as const;
export const AEO_MEMBERSHIP_TYP = "AEO-MEMBERSHIP+jwt" as const;
export const AEO_FRAMEWORK_AUDIENCE = "urn:aeo:framework" as const;
const RAW_ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const MAX_TOKEN_LENGTH = 16_384;
const MAX_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORM_ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export class AeoMembershipError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AeoMembershipError";
  }
}

export interface AeoTrustedIssuerKey {
  kid: string;
  issuer: string;
  algorithm: "Ed25519";
  publicKey: Uint8Array | string;
  notBefore?: number;
  notAfter?: number;
  revokedAt?: number;
}

export interface AeoMembershipVerificationOptions {
  trustedKeys: readonly AeoTrustedIssuerKey[];
  isCredentialRevoked: (input: {
    issuer: string;
    jti: string;
    platformId: string;
  }) => boolean | Promise<boolean>;
  nowSeconds?: number;
  clockSkewSeconds?: number;
  maxLifetimeSeconds?: number;
}

export interface AeoVerifiedMembership {
  valid: true;
  ecosystem: "AEO";
  issuer: string;
  platformId: string;
  platformName: string;
  publisherId: string;
  publisherKeyId: string;
  credentialId: string;
  issuedAt: number;
  expiresAt: number;
  scopes: readonly string[];
}

export interface AeoPeerRegistration {
  ecosystem: "AEO";
  protocol: typeof AEO_UCCS_PROTOCOL;
  platformId: string;
  displayName: string;
  membershipCredential: string;
}

function fail(code: string, message: string): never {
  throw new AeoMembershipError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function requiredString(value: unknown, field: string, maxLength = 255): string {
  if (typeof value !== "string" || !value || value.length > maxLength || value.trim() !== value) {
    fail("invalid_claims", `Invalid ${field}`);
  }
  return value;
}

function decodeBase64Url(value: string, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) fail("malformed_token", `Invalid ${field} encoding`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) fail("malformed_token", `Non-canonical ${field} encoding`);
  return decoded;
}

function decodeJson(value: string, field: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(decodeBase64Url(value, field).toString("utf8"));
    if (!isRecord(parsed)) fail("malformed_token", `${field} must be a JSON object`);
    return parsed;
  } catch (error) {
    if (error instanceof AeoMembershipError) throw error;
    fail("malformed_token", `Invalid ${field} JSON`);
  }
}

function importRawEd25519Key(value: string | Uint8Array): KeyObject {
  const raw = typeof value === "string" ? decodeBase64Url(value, "trusted public key") : Buffer.from(value);
  if (raw.length !== 32) fail("invalid_trust_key", "Ed25519 public key must be 32 bytes");
  return createPublicKey({
    key: Buffer.concat([RAW_ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

export async function verifyAeoMembershipCredential(
  compact: string,
  options: AeoMembershipVerificationOptions,
): Promise<AeoVerifiedMembership> {
  if (typeof compact !== "string" || !compact || compact.length > MAX_TOKEN_LENGTH) {
    fail("malformed_token", "Credential is missing or exceeds the size limit");
  }
  if (!options || !Array.isArray(options.trustedKeys) ||
      typeof options.isCredentialRevoked !== "function") {
    fail("invalid_verifier_config", "Trusted issuer keys and revocation checker are required");
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? 60;
  const maxLifetime = options.maxLifetimeSeconds ?? MAX_LIFETIME_SECONDS;
  if (!isInteger(now) || !isInteger(skew) || skew < 0 || skew > 300 ||
      !isInteger(maxLifetime) || maxLifetime < 60 || maxLifetime > MAX_LIFETIME_SECONDS) {
    fail("invalid_verifier_config", "Invalid verifier time configuration");
  }

  const parts = compact.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    fail("malformed_token", "Credential must be a three-part compact JWS");
  }
  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const encodedSignature = parts[2];
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    fail("malformed_token", "Credential contains an empty JWS segment");
  }

  const header = decodeJson(encodedHeader, "protected header");
  const claims = decodeJson(encodedPayload, "payload");
  if (header.alg !== "EdDSA" || header.typ !== AEO_MEMBERSHIP_TYP ||
      typeof header.kid !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(header.kid) ||
      Object.keys(header).some((key) => !["alg", "typ", "kid"].includes(key))) {
    fail("unsupported_header", "Credential does not match the AEO EdDSA membership profile");
  }

  const matches = options.trustedKeys.filter((candidate) => candidate.kid === header.kid);
  if (matches.length !== 1 || !matches[0]) fail("untrusted_issuer_key", "Signing key is missing or ambiguous");
  const key = matches[0];
  if (key.algorithm !== "Ed25519" || !key.issuer) fail("invalid_trust_key", "Trusted issuer key is invalid");
  if ((key.notBefore !== undefined && (!isInteger(key.notBefore) || now + skew < key.notBefore)) ||
      (key.notAfter !== undefined && (!isInteger(key.notAfter) || now - skew > key.notAfter)) ||
      (key.revokedAt !== undefined && (!isInteger(key.revokedAt) || now >= key.revokedAt)) ||
      (key.notBefore !== undefined && key.notAfter !== undefined && key.notAfter <= key.notBefore)) {
    fail("untrusted_issuer_key", "Signing key is outside its validity period or revoked");
  }

  const issuer = requiredString(claims.iss, "issuer");
  if (issuer !== key.issuer || claims.aud !== AEO_FRAMEWORK_AUDIENCE ||
      claims.ecosystem !== "AEO" || claims.credential_type !== "aeo-membership" ||
      claims.credential_version !== 1) {
    fail("wrong_credential_purpose", "Credential issuer, audience, ecosystem or type is invalid");
  }

  const platformId = requiredString(claims.sub, "platform ID");
  const platform = claims.platform;
  if (!PLATFORM_ID.test(platformId) || !isRecord(platform) || platform.id !== platformId) {
    fail("invalid_claims", "Signed platform identity is invalid or inconsistent");
  }
  const platformName = requiredString(platform.name, "platform name", 80);
  const publisher = claims.publisher;
  if (!isRecord(publisher)) fail("invalid_claims", "Publisher identity is missing");
  const publisherId = requiredString(publisher.id, "publisher ID");
  const publisherKeyId = requiredString(publisher.key_id, "publisher key ID", 128);
  if (!PLATFORM_ID.test(publisherId)) fail("invalid_claims", "Publisher ID is invalid");

  const credentialId = requiredString(claims.jti, "credential ID", 64);
  if (!UUID_V4.test(credentialId)) fail("invalid_claims", "Credential ID must be a UUIDv4");
  if (!Array.isArray(claims.scope) || !claims.scope.includes("member") ||
      claims.scope.some((scope) => typeof scope !== "string") ||
      new Set(claims.scope).size !== claims.scope.length) {
    fail("invalid_claims", "Membership scope must contain a unique member entry");
  }

  const { iat, nbf, exp } = claims;
  if (!isInteger(iat) || !isInteger(nbf) || !isInteger(exp) ||
      exp <= iat || nbf < iat || nbf > exp ||
      iat > now + skew || nbf > now + skew || exp <= now - skew ||
      exp - iat > maxLifetime) {
    fail("credential_time_invalid", "Credential is expired, not yet valid, or has an invalid lifetime");
  }

  const signature = decodeBase64Url(encodedSignature, "signature");
  if (signature.length !== 64) fail("malformed_token", "Ed25519 signature must be 64 bytes");
  let valid: boolean;
  try {
    valid = verifySignature(
      null,
      Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii"),
      importRawEd25519Key(key.publicKey),
      signature,
    );
  } catch {
    fail("crypto_unavailable", "Node.js Ed25519 verification is unavailable");
  }
  if (!valid) fail("invalid_signature", "Credential signature is invalid");

  let revoked: boolean;
  try {
    revoked = await options.isCredentialRevoked({ issuer, jti: credentialId, platformId });
  } catch {
    fail("revocation_check_failed", "Credential revocation status could not be checked");
  }
  if (revoked !== false) fail("credential_revoked_or_unknown", "Credential is revoked or its status is unknown");

  return Object.freeze({
    valid: true,
    ecosystem: "AEO",
    issuer,
    platformId,
    platformName,
    publisherId,
    publisherKeyId,
    credentialId,
    issuedAt: iat,
    expiresAt: exp,
    scopes: Object.freeze([...claims.scope]),
  });
}

export async function verifyAeoPeerRegistration(
  registration: AeoPeerRegistration,
  options: AeoMembershipVerificationOptions,
): Promise<{ valid: true; protocol: typeof AEO_UCCS_PROTOCOL; platformId: string; displayName: string; membership: AeoVerifiedMembership }> {
  if (!isRecord(registration) || registration.ecosystem !== "AEO" ||
      registration.protocol !== AEO_UCCS_PROTOCOL) {
    fail("invalid_registration", "Unsupported AEO ecosystem or UCCS protocol");
  }
  const platformId = requiredString(registration.platformId, "registration platform ID");
  const displayName = requiredString(registration.displayName, "registration display name", 80);
  if (!PLATFORM_ID.test(platformId)) fail("invalid_registration", "Registration platform ID is invalid");
  const membershipCredential = requiredString(registration.membershipCredential, "membership credential", MAX_TOKEN_LENGTH);
  const membership = await verifyAeoMembershipCredential(membershipCredential, options);
  if (membership.platformId !== platformId || membership.platformName !== displayName) {
    fail("registration_identity_mismatch", "Registration identity does not match signed membership credential");
  }
  return Object.freeze({
    valid: true,
    protocol: AEO_UCCS_PROTOCOL,
    platformId,
    displayName,
    membership,
  });
}
