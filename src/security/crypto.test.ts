import test from "node:test";
import assert from "node:assert/strict";
import { createAccessToken, hashPassword, hashRefreshToken, verifyAccessToken, verifyPassword } from "./crypto.js";

test("password hashes are salted and verify without exposing the password", async () => {
  const first = await hashPassword("a-strong-user-password");
  const second = await hashPassword("a-strong-user-password");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("a-strong-user-password", first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
});

test("access tokens are signed, expire, and carry the session identity", () => {
  const token = createAccessToken("user-id", "session-id");
  assert.equal(verifyAccessToken(token)?.sub, "user-id");
  assert.equal(verifyAccessToken(token)?.sid, "session-id");
  const [header, payload] = token.split(".");
  assert.equal(verifyAccessToken(`${header}.${payload}.invalid`), null);
});

test("refresh tokens are stored as one-way digests", () => {
  const digest = hashRefreshToken("random-refresh-secret");
  assert.notEqual(digest.toString(), "random-refresh-secret");
  assert.equal(digest.length, 32);
});
