import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

test("platform refresh rotation revokes a session family when an old token is replayed", async () => {
  const app = await buildApp();
  try {
    const registered = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `refresh-${Date.now()}@example.test`,
        password: "Strong-password-123!",
        name: "Refresh Test",
      },
    });
    assert.equal(registered.statusCode, 201, registered.body);
    assert.equal(registered.json().expiresIn, 900);
    const firstRefresh = registered.json().refreshToken as string;

    const rotated = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/refresh",
      payload: { refreshToken: firstRefresh },
    });
    assert.equal(rotated.statusCode, 200, rotated.body);
    const rotatedSession = rotated.json();

    const replayed = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/refresh",
      payload: { refreshToken: firstRefresh },
    });
    assert.equal(replayed.statusCode, 401);

    const accessAfterReplay = await app.inject({
      method: "GET",
      url: "/v1/platform/auth/me",
      headers: { authorization: `Bearer ${rotatedSession.accessToken}` },
    });
    assert.equal(accessAfterReplay.statusCode, 401);

    const refreshAfterReplay = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/refresh",
      payload: { refreshToken: rotatedSession.refreshToken },
    });
    assert.equal(refreshAfterReplay.statusCode, 401);
  } finally {
    await app.close();
  }
});
