import { createHmac, createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

function derive(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

type AccessClaims = { sub: string; sid: string; iat: number; exp: number; iss: "maary-base" };

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function signature(input: string): Buffer {
  return createHmac("sha256", config.TOKEN_SECRET).update(input).digest();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derive(password, salt, 64);
  return `scrypt$16384$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, cost, saltText, hashText] = encoded.split("$");
  if (algorithm !== "scrypt" || cost !== "16384" || !saltText || !hashText) return false;
  try {
    const expected = Buffer.from(hashText, "base64url");
    const actual = await derive(password, Buffer.from(saltText, "base64url"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function createRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

export function hashRefreshToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createAccessToken(userId: string, sessionId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims: AccessClaims = { sub: userId, sid: sessionId, iat: now, exp: now + ACCESS_TTL_SECONDS, iss: "maary-base" };
  const payload = base64url(JSON.stringify(claims));
  const signed = `${header}.${payload}`;
  return `${signed}.${signature(signed).toString("base64url")}`;
}

export function verifyAccessToken(token: string): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const signed = `${parts[0]}.${parts[1]}`;
  const supplied = Buffer.from(parts[2], "base64url");
  const expected = signature(signed);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; typ?: string };
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as AccessClaims;
    if (header.alg !== "HS256" || header.typ !== "JWT" || claims.iss !== "maary-base" || typeof claims.sub !== "string" || typeof claims.sid !== "string" || !Number.isInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export const refreshTokenLifetimeSeconds = REFRESH_TTL_SECONDS;
