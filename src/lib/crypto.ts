import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config.js";
import { UnauthorizedError } from "./errors.js";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const [, salt, keyHex] = parts;
  if (!salt || !keyHex) return false;
  const expectedBuffer = Buffer.from(keyHex, "hex");
  const derivedKey = (await scrypt(password, salt, 64)) as Buffer;
  if (expectedBuffer.length !== derivedKey.length) return false;
  return timingSafeEqual(expectedBuffer, derivedKey);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function generateApiKey(prefix: "anon" | "service" | "pat" | "key"): {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
} {
  const randomPart = randomBytes(28).toString("base64url");
  const rawKey = `mb_${prefix}_${randomPart}`;
  const keyPrefix = rawKey.slice(0, 16);
  const keyHash = hashToken(rawKey);
  return { rawKey, keyPrefix, keyHash };
}

function deriveKey32(rawKey: string): Buffer {
  return createHash("sha256").update(rawKey).digest();
}

export interface EncryptedSecretPayload {
  encryptedValue: string;
  iv: string;
  authTag: string;
}

export function encryptSecret(
  plaintext: string,
  masterKey: string = config.ENCRYPTION_KEY
): EncryptedSecretPayload {
  const key = deriveKey32(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    encryptedValue: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

export function decryptSecret(
  payload: EncryptedSecretPayload,
  masterKey: string = config.ENCRYPTION_KEY
): string {
  const key = deriveKey32(masterKey);
  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const encrypted = Buffer.from(payload.encryptedValue, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export interface JwtClaims {
  sub: string;
  role: string;
  iss?: string;
  project_id?: string;
  env?: string;
  email?: string;
  scopes?: string[];
  session_id?: string;
  token_type?: "platform_access" | "project_access" | "api_key" | "signed_url";
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  iat?: number;
  exp?: number;
  jti?: string;
  [key: string]: unknown;
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function signJwt(
  claims: JwtClaims,
  ttlSeconds = 3600,
  secret: string = config.JWT_SECRET
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: JwtClaims = {
    iss: "maary-base",
    jti: randomUUID(),
    ...claims,
    iat: claims.iat ?? now,
    exp: claims.exp ?? now + ttlSeconds,
  };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

export function verifyJwt(
  token: string,
  secret: string = config.JWT_SECRET
): JwtClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new UnauthorizedError("Malformed JWT token.");
  }
  const [encodedHeader, encodedPayload, signature] = parts;
  if (!encodedHeader || !encodedPayload || !signature) {
    throw new UnauthorizedError("Malformed JWT token.");
  }
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new UnauthorizedError("Invalid token signature.");
  }

  let payload: JwtClaims;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as JwtClaims;
  } catch {
    throw new UnauthorizedError("Invalid token payload.");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    throw new UnauthorizedError("Token has expired.");
  }
  return payload;
}

export interface SignedStorageTokenPayload {
  projectId: string;
  bucketName: string;
  objectPath: string;
  operation: "download" | "upload";
  exp: number;
}

export function signStorageToken(
  payload: Omit<SignedStorageTokenPayload, "exp">,
  expiresInSeconds: number,
  secret: string = config.JWT_SECRET
): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const fullPayload: SignedStorageTokenPayload = { ...payload, exp };
  const data = base64UrlEncode(JSON.stringify(fullPayload));
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyStorageToken(
  token: string,
  secret: string = config.JWT_SECRET
): SignedStorageTokenPayload {
  const [data, sig] = token.split(".");
  if (!data || !sig) {
    throw new UnauthorizedError("Invalid signed storage URL token.");
  }
  const expectedSig = createHmac("sha256", secret)
    .update(data)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new UnauthorizedError("Invalid signed storage URL signature.");
  }
  const parsed = JSON.parse(
    base64UrlDecode(data)
  ) as SignedStorageTokenPayload;
  const now = Math.floor(Date.now() / 1000);
  if (parsed.exp < now) {
    throw new UnauthorizedError("Signed storage URL has expired.");
  }
  return parsed;
}
