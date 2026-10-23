import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { buildApp } from "./app.js";
import { createMaaryClient } from "./sdk/index.js";
import { runCli } from "./cli/index.js";

test("Object Storage: buckets, policies, quotas, MIME checks, signed URLs, and multipart uploads", async () => {
  const app = await buildApp();
  try {
    const opReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `storage-op-${Date.now()}@maary.dev`,
        password: "OperatorPass123!",
      },
    });
    const opToken = opReg.json().accessToken as string;

    const slug = `storage-proj-${Date.now()}`;
    const projRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${opToken}` },
      payload: { name: "Storage Project", slug },
    });
    const { anonKey, serviceRoleKey } = projRes.json().apiKeys;

    // 1. Create a private bucket with MIME restriction and size limit
    const createPrivateBucket = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        name: "vault",
        public: false,
        fileSizeLimitBytes: 2048,
        quotaBytes: 8192,
        allowedMimeTypes: ["text/*", "application/json"],
      },
    });
    assert.equal(createPrivateBucket.statusCode, 201);

    // 2. Register two users: Alice and Bob
    const aliceRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/signup`,
      headers: { apikey: anonKey },
      payload: { email: "alice@storage.io", password: "Password123!" },
    });
    const aliceJwt = aliceRes.json().session.access_token as string;

    const bobRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/auth/signup`,
      headers: { apikey: anonKey },
      payload: { email: "bob@storage.io", password: "Password123!" },
    });
    const bobJwt = bobRes.json().session.access_token as string;

    // 3. Without a storage policy, Alice cannot upload to private bucket 'vault'
    const deniedUpload = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets/vault/objects/private/notes.txt`,
      headers: { apikey: anonKey, authorization: `Bearer ${aliceJwt}` },
      payload: { content: "Secret note", mimeType: "text/plain" },
    });
    assert.equal(deniedUpload.statusCode, 403);

    // 4. Add Storage Policy allowing authenticated users owner-only access under 'private/'
    const policyRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets/vault/policies`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        name: "authenticated_owner_access",
        operation: "ALL",
        roles: ["authenticated"],
        pathPrefix: "private/",
        allowOwnerOnly: true,
      },
    });
    assert.equal(policyRes.statusCode, 201);

    // 5. Alice can now upload her file under 'private/notes.txt'
    const allowedUpload = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets/vault/objects/private/notes.txt`,
      headers: { apikey: anonKey, authorization: `Bearer ${aliceJwt}` },
      payload: {
        content: "Alice top secret document",
        mimeType: "text/plain",
        metadata: { classification: "confidential" },
      },
    });
    assert.equal(allowedUpload.statusCode, 201);
    assert.equal(allowedUpload.json().object.size_bytes, 25);

    // 6. Disallowed MIME type is rejected with 400
    const badMimeUpload = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets/vault/objects/private/binary.exe`,
      headers: { apikey: anonKey, authorization: `Bearer ${aliceJwt}` },
      payload: {
        content: "MZ...",
        mimeType: "application/x-msdownload",
      },
    });
    assert.equal(badMimeUpload.statusCode, 400);

    // 7. File exceeding bucket fileSizeLimitBytes (2048 B) is rejected with 429
    const oversizedUpload = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets/vault/objects/private/huge.txt`,
      headers: { apikey: anonKey, authorization: `Bearer ${aliceJwt}` },
      payload: {
        content: "x".repeat(3000),
        mimeType: "text/plain",
      },
    });
    assert.equal(oversizedUpload.statusCode, 429);

    // 8. Bob cannot overwrite or delete Alice's file because allowOwnerOnly=true
    const bobOverwrite = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets/vault/objects/private/notes.txt`,
      headers: { apikey: anonKey, authorization: `Bearer ${bobJwt}` },
      payload: { content: "Hacked by Bob", mimeType: "text/plain" },
    });
    assert.equal(bobOverwrite.statusCode, 403);

    const bobDownload = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/storage/buckets/vault/objects/private/notes.txt`,
      headers: { apikey: anonKey, authorization: `Bearer ${bobJwt}` },
    });
    assert.equal(bobDownload.statusCode, 403);

    // 9. Alice creates a Signed Download URL and shares it -> works without auth header!
    const signRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/buckets/vault/sign/private/notes.txt`,
      headers: { apikey: anonKey, authorization: `Bearer ${aliceJwt}` },
      payload: { operation: "download", expiresIn: 300 },
    });
    assert.equal(signRes.statusCode, 200);
    const { signedUrl } = signRes.json();

    const signedDownload = await app.inject({
      method: "GET",
      url: signedUrl,
    });
    assert.equal(signedDownload.statusCode, 200);
    assert.equal(signedDownload.body, "Alice top secret document");

    // Tampered signed URL fails with 401
    const tamperedDownload = await app.inject({
      method: "GET",
      url: `${signedUrl}tampered`,
    });
    assert.equal(tamperedDownload.statusCode, 401);

    // 10. Multipart / Resumable Upload
    const initMulti = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/multipart/initiate`,
      headers: { apikey: serviceRoleKey },
      payload: {
        bucketName: "vault",
        path: "private/multi.txt",
        mimeType: "text/plain",
      },
    });
    assert.equal(initMulti.statusCode, 201);
    const uploadId = initMulti.json().upload.id as string;

    const part1 = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/multipart/${uploadId}/parts/1`,
      headers: { apikey: serviceRoleKey },
      payload: { content: "Part One - " },
    });
    assert.equal(part1.statusCode, 200);

    const part2 = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/multipart/${uploadId}/parts/2`,
      headers: { apikey: serviceRoleKey },
      payload: { content: "Part Two Complete!" },
    });
    assert.equal(part2.statusCode, 200);

    const completeMulti = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/storage/multipart/${uploadId}/complete`,
      headers: { apikey: serviceRoleKey },
    });
    assert.equal(completeMulti.statusCode, 201);

    const verifyMultiDownload = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/storage/buckets/vault/objects/private/multi.txt`,
      headers: { apikey: serviceRoleKey },
    });
    assert.equal(verifyMultiDownload.statusCode, 200);
    assert.equal(verifyMultiDownload.body, "Part One - Part Two Complete!");
  } finally {
    await app.close();
  }
});

test("Server Functions, Sandbox Security, Background Queues, Retries, Backups, SDK, CLI, and Live WebSocket Realtime", async () => {
  const app = await buildApp();
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  try {
    const opReg = await app.inject({
      method: "POST",
      url: "/v1/platform/auth/register",
      payload: {
        email: `ops-${Date.now()}@maary.dev`,
        password: "OperatorPass123!",
      },
    });
    const opToken = opReg.json().accessToken as string;

    const slug = `ops-proj-${Date.now()}`;
    const projRes = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { authorization: `Bearer ${opToken}` },
      payload: { name: "Operations & Realtime Project", slug },
    });
    const { anonKey, serviceRoleKey } = projRes.json().apiKeys;

    // 1. Create a 'tasks' table
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/database/tables`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        name: "tasks",
        enableRls: false,
        columns: [
          { name: "id", type: "serial", primaryKey: true },
          { name: "name", type: "text", notNull: true },
          { name: "done", type: "boolean", defaultValue: "false" },
        ],
      },
    });

    // 2. Store an encrypted project secret for the function to read
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/secrets`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        name: "APP_GREETING",
        value: "HelloFromEncryptedSecret",
      },
    });

    // 3. Deploy a Server Function that queries the project schema and reads secret
    const deployFn = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        slug: "create-task-fn",
        verifyJwt: true,
        timeoutMs: 3000,
        code: `
          async function handler(ctx) {
            console.log("Executing create-task-fn for:", ctx.req.body?.taskName);
            const taskName = ctx.req.body?.taskName || "Default Task";
            const inserted = await ctx.db.query(
              "INSERT INTO tasks (name, done) VALUES ($1, false) RETURNING *",
              [taskName]
            );
            return {
              statusCode: 201,
              body: {
                secretGreeting: ctx.env.APP_GREETING,
                createdTask: inserted.rows[0]
              }
            };
          }
        `,
      },
    });
    assert.equal(deployFn.statusCode, 201);

    // 4. Unauthenticated invocation is rejected when verifyJwt = true
    const unauthInvoke = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions/create-task-fn/invoke`,
      payload: { taskName: "Should Fail" },
    });
    assert.equal(unauthInvoke.statusCode, 403);

    // 5. Deploy a timeout test function to verify sandbox CPU timeout isolation
    await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        slug: "infinite-loop",
        verifyJwt: false,
        timeoutMs: 250,
        code: `function handler() { while (true) {} }`,
      },
    });

    const timeoutRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/functions/infinite-loop/invoke`,
    });
    assert.equal(timeoutRes.statusCode, 504);

    // 6. Connect a Real WebSocket Client to Realtime and subscribe to 'db:tasks'
    const receivedEvents: any[] = [];
    const wsUrl = `${address.replace(/^http/, "ws")}/v1/projects/${slug}/realtime/ws?apikey=${encodeURIComponent(anonKey)}`;
    const ws = new WebSocket(wsUrl);

    await new Promise<void>((resolvePromise, rejectPromise) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "connected") {
          ws.send(JSON.stringify({ type: "subscribe", topic: "db:tasks" }));
        } else if (msg.type === "subscribed") {
          resolvePromise();
        } else if (
          msg.type === "postgres_changes" ||
          msg.type === "broadcast"
        ) {
          receivedEvents.push(msg);
        }
      });
      ws.once("error", rejectPromise);
    });

    // 7. Invoke 'create-task-fn' via the TypeScript Client SDK!
    const maary = createMaaryClient(address, serviceRoleKey, {
      projectRef: slug,
    });

    const fnResult = await maary.functions.invoke("create-task-fn", {
      body: { taskName: "Realtime Verified Task" },
    });
    assert.equal(fnResult.error, null);
    assert.equal(fnResult.data.secretGreeting, "HelloFromEncryptedSecret");
    assert.equal(fnResult.data.createdTask.name, "Realtime Verified Task");
    assert.equal(fnResult.logs.length, 1);

    // Wait briefly for WebSocket delivery of the INSERT event triggered by the function's DB insert!
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(
      receivedEvents.some(
        (e) =>
          e.type === "postgres_changes" &&
          e.operation === "INSERT" &&
          e.record?.name === "Realtime Verified Task"
      )
    );

    ws.close();

    // 8. Background Jobs Queue, Idempotency & Dead-Letter Handling
    // Enqueue a job that invokes 'create-task-fn'
    const job1Res = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/jobs`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        jobType: "function",
        payload: {
          functionSlug: "create-task-fn",
          body: { taskName: "Background Queued Task" },
        },
        idempotencyKey: "unique-job-1",
      },
    });
    assert.equal(job1Res.statusCode, 201);
    const job1Id = job1Res.json().job.id as string;

    // Duplicate idempotencyKey returns the exact same job
    const job1Dup = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/jobs`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        jobType: "function",
        payload: { functionSlug: "create-task-fn" },
        idempotencyKey: "unique-job-1",
      },
    });
    assert.equal(job1Dup.json().job.id, job1Id);

    // Enqueue a failing job with maxAttempts = 1 -> should transition to dead_letter
    const failingJobRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/jobs`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: {
        jobType: "function",
        payload: { functionSlug: "non-existent-function" },
        maxAttempts: 1,
      },
    });
    const failingJobId = failingJobRes.json().job.id as string;

    // Process due jobs
    const processRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/jobs/process`,
      headers: { authorization: `Bearer ${opToken}` },
    });
    assert.equal(processRes.statusCode, 200);

    const checkJob1 = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/jobs/${job1Id}`,
      headers: { authorization: `Bearer ${opToken}` },
    });
    assert.equal(checkJob1.json().job.status, "completed");

    const checkFailingJob = await app.inject({
      method: "GET",
      url: `/v1/projects/${slug}/jobs/${failingJobId}`,
      headers: { authorization: `Bearer ${opToken}` },
    });
    assert.equal(checkFailingJob.json().job.status, "dead_letter");

    // 9. Verify 2 tasks now exist via SDK .from("tasks").select()
    const { data: tasksBeforeBackup, error: selectErr } = await maary
      .from("tasks")
      .select("*")
      .order("id", { ascending: true });
    assert.equal(selectErr, null);
    assert.equal(tasksBeforeBackup?.length, 2);

    // 10. Create Backup Snapshot, Verify Integrity, Delete Data, and Restore Backup!
    const backupCreateRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/backups`,
      headers: { authorization: `Bearer ${opToken}` },
      payload: { name: "Before accidental delete" },
    });
    assert.equal(backupCreateRes.statusCode, 201);
    const backupId = backupCreateRes.json().backup.id as string;

    // Verify backup SHA-256 checksum
    const verifyBackupRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/backups/${backupId}/verify`,
      headers: { authorization: `Bearer ${opToken}` },
    });
    assert.equal(verifyBackupRes.statusCode, 200);
    assert.equal(verifyBackupRes.json().valid, true);

    // Delete all tasks
    await maary.from("tasks").delete().gt("id", 0);
    const { data: tasksAfterDelete } = await maary.from("tasks").select("*");
    assert.equal(tasksAfterDelete?.length, 0);

    // Restore from backup snapshot!
    const restoreRes = await app.inject({
      method: "POST",
      url: `/v1/projects/${slug}/backups/${backupId}/restore`,
      headers: { authorization: `Bearer ${opToken}` },
    });
    assert.equal(restoreRes.statusCode, 200);
    assert.equal(restoreRes.json().restoredRows, 2);

    // Verify both tasks are back!
    const { data: tasksAfterRestore } = await maary
      .from("tasks")
      .select("*")
      .order("id", { ascending: true });
    assert.equal(tasksAfterRestore?.length, 2);
    assert.equal(tasksAfterRestore?.[0].name, "Realtime Verified Task");
    assert.equal(tasksAfterRestore?.[1].name, "Background Queued Task");

    // 11. Verify CLI commands
    const cliStatus = await runCli(["status"]);
    assert.equal(cliStatus.exitCode, 0);
    assert.equal((cliStatus.output as any).status, "healthy");

    const cliSql = await runCli([
      "sql",
      slug,
      "SELECT COUNT(*)::int AS cnt FROM tasks",
    ]);
    assert.equal(cliSql.exitCode, 0);
    assert.equal((cliSql.output as any).rows[0].cnt, 2);
  } finally {
    await app.close();
  }
});
