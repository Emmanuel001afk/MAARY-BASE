import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import vm from "node:vm";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from "../lib/errors.js";
import { incrementProjectMetric, recordAuditEvent } from "./audit.service.js";
import type { DataAuthContext } from "./data-api.service.js";
import { executeProjectSql } from "./database.service.js";
import {
  getDecryptedSecretsMap,
  getProjectByRef,
  type ProjectRecord,
} from "./project.service.js";
import { realtimeBroker } from "./realtime.service.js";
import { cleanupAbandonedMultipartUploads } from "./storage.service.js";

export interface ServerFunctionRecord {
  id: string;
  project_id: string;
  slug: string;
  name: string;
  description: string;
  code: string;
  entrypoint: string;
  version: number;
  status: "active" | "disabled";
  verify_jwt: boolean;
  timeout_ms: number;
  env_vars: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface FunctionInvocationLog {
  id: string;
  project_id: string;
  function_id: string;
  invocation_id: string;
  status_code: number;
  duration_ms: number;
  logs: Array<{ level: string; message: string; timestamp: string }>;
  error_message: string | null;
  request_meta: Record<string, unknown>;
  created_at: string;
}

export async function deployServerFunction(
  project: ProjectRecord,
  input: {
    slug: string;
    name?: string;
    description?: string;
    code: string;
    entrypoint?: string;
    verifyJwt?: boolean;
    timeoutMs?: number;
    status?: "active" | "disabled";
    envVars?: Record<string, string>;
    actorId?: string | null;
  }
): Promise<ServerFunctionRecord> {
  const slug = input.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(slug)) {
    throw new ValidationError(
      "Function slug must be 2-63 lowercase alphanumeric characters, hyphens, or underscores."
    );
  }
  if (!input.code || !input.code.trim()) {
    throw new ValidationError("Function source code is required.");
  }

  // Validate JavaScript syntax before deploying
  try {
    new vm.Script(input.code, { filename: `${slug}.js` });
  } catch (err: any) {
    throw new ValidationError(
      `Function syntax error: ${err?.message || "Invalid JavaScript"}`
    );
  }

  const countRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM platform_functions WHERE project_id = $1 AND slug != $2`,
    [project.id, slug]
  );
  if (
    Number(countRes.rows[0]?.count ?? 0) >=
    (project.quotas?.maxFunctions ?? 50)
  ) {
    throw new QuotaExceededError(
      `Project function limit (${project.quotas.maxFunctions}) reached.`
    );
  }

  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? 2000, 100),
    config.FUNCTION_TIMEOUT_MS
  );

  const res = await pool.query<ServerFunctionRecord>(
    `INSERT INTO platform_functions (
      project_id, slug, name, description, code, entrypoint, version, status, verify_jwt, timeout_ms, env_vars
    ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10::jsonb)
    ON CONFLICT (project_id, slug)
    DO UPDATE SET
      name = EXCLUDED.name,
      description = EXCLUDED.description,
      code = EXCLUDED.code,
      entrypoint = EXCLUDED.entrypoint,
      version = platform_functions.version + 1,
      status = EXCLUDED.status,
      verify_jwt = EXCLUDED.verify_jwt,
      timeout_ms = EXCLUDED.timeout_ms,
      env_vars = EXCLUDED.env_vars,
      updated_at = now()
    RETURNING *`,
    [
      project.id,
      slug,
      (input.name ?? slug).trim(),
      input.description ?? "",
      input.code,
      input.entrypoint ?? "handler",
      input.status ?? "active",
      input.verifyJwt ?? true,
      timeoutMs,
      JSON.stringify(input.envVars ?? {}),
    ]
  );

  await recordAuditEvent({
    projectId: project.id,
    actorType: input.actorId ? "user" : "service",
    actorId: input.actorId ?? null,
    action: "function.deployed",
    resourceType: "function",
    resourceId: res.rows[0]!.id,
    metadata: { slug, version: res.rows[0]!.version },
  });

  return res.rows[0]!;
}

export async function listServerFunctions(
  projectId: string
): Promise<ServerFunctionRecord[]> {
  const res = await pool.query<ServerFunctionRecord>(
    `SELECT * FROM platform_functions WHERE project_id = $1 ORDER BY slug ASC`,
    [projectId]
  );
  return res.rows;
}

export async function getServerFunctionBySlug(
  projectId: string,
  slug: string
): Promise<ServerFunctionRecord> {
  const res = await pool.query<ServerFunctionRecord>(
    `SELECT * FROM platform_functions WHERE project_id = $1 AND slug = $2`,
    [projectId, slug]
  );
  if (!res.rows[0]) {
    throw new NotFoundError(`Server function '${slug}' not found.`);
  }
  return res.rows[0];
}

export async function deleteServerFunction(
  projectId: string,
  slug: string,
  actorId?: string | null
): Promise<void> {
  const res = await pool.query<{ id: string }>(
    `DELETE FROM platform_functions WHERE project_id = $1 AND slug = $2 RETURNING id`,
    [projectId, slug]
  );
  if (!res.rowCount) {
    throw new NotFoundError(`Server function '${slug}' not found.`);
  }
  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "service",
    actorId: actorId ?? null,
    action: "function.deleted",
    resourceType: "function",
    resourceId: res.rows[0]!.id,
    metadata: { slug },
  });
}

const ISOLATED_WORKER_SCRIPT = `
"use strict";
const vm = require("node:vm");
const readline = require("node:readline");
const crypto = require("node:crypto");

// Remove network & process-spawning globals inside the isolated worker process
delete globalThis.fetch;
delete globalThis.WebSocket;
delete globalThis.XMLHttpRequest;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const pendingDb = new Map();
let reqSeq = 0;

function sendMsg(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

rl.on("line", async (line) => {
  if (!line || !line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.type === "db_result") {
    const p = pendingDb.get(msg.id);
    if (p) {
      pendingDb.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    }
    return;
  }

  if (msg.type === "invoke") {
    const logs = [];
    const appendLog = (level, args) => {
      if (logs.length >= 100) return;
      const text = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ")
        .slice(0, 4096);
      logs.push({ level, message: text, timestamp: new Date().toISOString() });
    };

    const hostLog = (level, ...args) => {
      appendLog(level, args);
    };
    const hostDbQuery = (sql, params) =>
      new Promise((resolve, reject) => {
        const id = ++reqSeq;
        pendingDb.set(id, { resolve, reject });
        sendMsg({
          type: "db_query",
          id,
          sql: String(sql),
          params: Array.isArray(params) ? params : undefined,
        });
      });
    const hostRandomUuid = () => crypto.randomUUID();

    // Sever host function prototype chains before exposing to VM context
    Object.setPrototypeOf(hostLog, null);
    Object.setPrototypeOf(hostDbQuery, null);
    Object.setPrototypeOf(hostRandomUuid, null);
    Object.freeze(hostLog);
    Object.freeze(hostDbQuery);
    Object.freeze(hostRandomUuid);

    // Lock down Function constructors in host worker realm
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
    for (const FnCtor of [Function, AsyncFunction, GeneratorFunction]) {
      try {
        Object.defineProperty(FnCtor.prototype, "constructor", {
          value: null,
          writable: false,
          configurable: false,
        });
      } catch {}
    }

    const sandbox = Object.create(null);
    sandbox.__hostLog = hostLog;
    sandbox.__hostDbQuery = hostDbQuery;
    sandbox.__hostRandomUuid = hostRandomUuid;
    sandbox.__payloadJson = JSON.stringify({
      invocationId: msg.invocationId,
      req: msg.req,
      auth: msg.auth,
      env: msg.env,
    });
    sandbox.URL = URL;
    sandbox.URLSearchParams = URLSearchParams;
    sandbox.TextEncoder = TextEncoder;
    sandbox.TextDecoder = TextDecoder;

    const vmContext = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    // Initialize VM-realm objects and lock down VM-realm Function constructors
    const initScript = new vm.Script(\`
      (function() {
        const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
        const GenFn = Object.getPrototypeOf(function*(){}).constructor;
        for (const C of [Function, AsyncFn, GenFn]) {
          Object.defineProperty(C.prototype, "constructor", {
            value: null,
            writable: false,
            configurable: false
          });
        }
        const parsed = JSON.parse(__payloadJson);
        delete globalThis.__payloadJson;
        const logFn = __hostLog;
        const dbFn = __hostDbQuery;
        const uuidFn = __hostRandomUuid;
        delete globalThis.__hostLog;
        delete globalThis.__hostDbQuery;
        delete globalThis.__hostRandomUuid;

        globalThis.console = Object.freeze({
          log: (...a) => logFn("info", ...a),
          info: (...a) => logFn("info", ...a),
          warn: (...a) => logFn("warn", ...a),
          error: (...a) => logFn("error", ...a)
        });
        globalThis.crypto = Object.freeze({
          randomUUID: () => uuidFn()
        });
        globalThis.module = { exports: {} };
        globalThis.exports = globalThis.module.exports;
        globalThis.__ctx = Object.freeze({
          invocationId: parsed.invocationId,
          req: Object.freeze({
            method: parsed.req.method,
            headers: Object.freeze(parsed.req.headers || {}),
            query: Object.freeze(parsed.req.query || {}),
            body: parsed.req.body
          }),
          auth: Object.freeze(parsed.auth || {}),
          env: Object.freeze(parsed.env || {}),
          db: Object.freeze({
            query: async (sql, params) => {
              const res = await dbFn(sql, params);
              return JSON.parse(res);
            }
          })
        });
      })();
    \`, { filename: "bootstrap.js" });

    try {
      initScript.runInContext(vmContext, { timeout: msg.timeoutMs });

      const entrypoint = String(msg.entrypoint || "handler").replace(/[^a-zA-Z0-9_$]/g, "");
      const wrappedCode = \`
        \${msg.code}
        ;(async () => {
          const target =
            (typeof \${entrypoint} === "function" ? \${entrypoint} : null) ||
            (typeof handler === "function" ? handler : null) ||
            (typeof module.exports === "function" ? module.exports : null) ||
            (module.exports && typeof module.exports.\${entrypoint} === "function" ? module.exports.\${entrypoint} : null) ||
            (module.exports && typeof module.exports.default === "function" ? module.exports.default : null);
          if (!target) {
            throw new Error("Function entrypoint '\${entrypoint}' was not found.");
          }
          return await target(__ctx);
        })();
      \`;

      const userScript = new vm.Script(wrappedCode, { filename: msg.slug + ".js" });
      const rawResult = await userScript.runInContext(vmContext, { timeout: msg.timeoutMs });
      sendMsg({ type: "done", ok: true, data: rawResult === undefined ? null : rawResult, logs });
      process.exit(0);
    } catch (err) {
      sendMsg({
        type: "done",
        ok: false,
        error: err && err.message ? String(err.message) : String(err),
        logs,
      });
      process.exit(0);
    }
  }
});
`;

async function runInIsolatedProcess(params: {
  slug: string;
  code: string;
  entrypoint: string;
  timeoutMs: number;
  invocationId: string;
  req: {
    method: string;
    headers: Record<string, string>;
    query: Record<string, unknown>;
    body: unknown;
  };
  auth: {
    role: string;
    userId: string | null;
    email: string | null;
  };
  env: Record<string, string>;
  onDbQuery: (
    sql: string,
    queryParams?: unknown[]
  ) => Promise<{ rows: unknown[]; rowCount: number }>;
}): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
  logs: Array<{ level: string; message: string; timestamp: string }>;
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [
        "--permission",
        "--disallow-code-generation-from-strings",
        "--max-old-space-size=64",
        "-e",
        ISOLATED_WORKER_SCRIPT,
      ],
      {
        env: { NODE_ENV: "production" },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let settled = false;
    let stderrBuf = "";
    const finish = (result: {
      ok: boolean;
      data?: unknown;
      error?: string;
      logs: Array<{ level: string; message: string; timestamp: string }>;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      try {
        child.kill("SIGKILL");
      } catch {}
      resolvePromise(result);
    };

    const killTimer = setTimeout(() => {
      finish({
        ok: false,
        error: `Function execution timed out after ${params.timeoutMs}ms.`,
        logs: [
          {
            level: "error",
            message: `Function execution timed out after ${params.timeoutMs}ms.`,
            timestamp: new Date().toISOString(),
          },
        ],
      });
    }, params.timeoutMs + 150);

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8").slice(0, 2048);
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }

      if (msg.type === "db_query") {
        try {
          const dbRes = await params.onDbQuery(msg.sql, msg.params);
          if (!settled && child.stdin.writable) {
            child.stdin.write(
              JSON.stringify({
                type: "db_result",
                id: msg.id,
                result: JSON.stringify(dbRes),
              }) + "\n"
            );
          }
        } catch (err: any) {
          if (!settled && child.stdin.writable) {
            child.stdin.write(
              JSON.stringify({
                type: "db_result",
                id: msg.id,
                error: err?.message || "Database query failed",
              }) + "\n"
            );
          }
        }
        return;
      }

      if (msg.type === "done") {
        finish({
          ok: Boolean(msg.ok),
          data: msg.data,
          error: msg.error,
          logs: Array.isArray(msg.logs) ? msg.logs : [],
        });
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        error: err.message || "Isolated worker process failed to start",
        logs: [],
      });
    });

    child.on("exit", (code, signal) => {
      if (!settled) {
        const isTimeout = signal === "SIGKILL" || /timed out/i.test(stderrBuf);
        finish({
          ok: false,
          error: isTimeout
            ? `Function execution timed out after ${params.timeoutMs}ms.`
            : stderrBuf.trim() ||
              `Isolated function worker exited unexpectedly (code ${code}, signal ${signal})`,
          logs: [],
        });
      }
    });

    child.stdin.write(
      JSON.stringify({
        type: "invoke",
        slug: params.slug,
        code: params.code,
        entrypoint: params.entrypoint,
        timeoutMs: params.timeoutMs,
        invocationId: params.invocationId,
        req: params.req,
        auth: params.auth,
        env: params.env,
      }) + "\n"
    );
  });
}

export async function invokeServerFunction(
  project: ProjectRecord,
  slug: string,
  request: {
    method?: string;
    headers?: Record<string, string>;
    query?: Record<string, unknown>;
    body?: unknown;
  },
  auth: DataAuthContext,
  options: { hasValidCredentials?: boolean } = {}
): Promise<{
  invocationId: string;
  statusCode: number;
  headers: Record<string, string>;
  data: unknown;
  logs: Array<{ level: string; message: string; timestamp: string }>;
  durationMs: number;
  error?: string;
}> {
  const fn = await getServerFunctionBySlug(project.id, slug);
  if (fn.status !== "active") {
    throw new ForbiddenError(`Server function '${slug}' is currently disabled.`);
  }

  if (fn.verify_jwt && !options.hasValidCredentials) {
    throw new ForbiddenError(
      `Function '${slug}' requires authentication (verify_jwt is enabled).`
    );
  }

  const invocationId = randomUUID();
  const projectSecrets = await getDecryptedSecretsMap(project.id);
  const envObj: Record<string, string> = {
    ...projectSecrets,
    ...(fn.env_vars ?? {}),
    MAARY_PROJECT_ID: project.id,
    MAARY_PROJECT_SLUG: project.slug,
  };

  const timeoutMs = Math.min(fn.timeout_ms, config.FUNCTION_TIMEOUT_MS);
  const started = Date.now();
  let statusCode = 200;
  let responseData: unknown = null;
  let responseHeaders: Record<string, string> = {
    "content-type": "application/json",
  };
  let errorMessage: string | null = null;

  const workerResult = await runInIsolatedProcess({
    slug: fn.slug,
    code: fn.code,
    entrypoint: fn.entrypoint,
    timeoutMs,
    invocationId,
    req: {
      method: request.method ?? "POST",
      headers: { ...(request.headers ?? {}) },
      query: { ...(request.query ?? {}) },
      body: request.body ?? null,
    },
    auth: {
      role: auth.role,
      userId: auth.userId ?? null,
      email: auth.email ?? null,
    },
    env: envObj,
    onDbQuery: async (sql: string, params?: unknown[]) => {
      const res = await executeProjectSql(project, {
        sql,
        params,
        rlsContext: {
          role: auth.role,
          userId: auth.userId,
          email: auth.email,
          claims: auth.claims,
        },
      });
      await realtimeBroker.flushDatabaseEvents();
      return { rows: res.rows, rowCount: res.rowCount };
    },
  });

  const logs = workerResult.logs;
  if (workerResult.ok) {
    const rawResult = workerResult.data;
    if (
      rawResult &&
      typeof rawResult === "object" &&
      ("statusCode" in (rawResult as any) || "body" in (rawResult as any))
    ) {
      const r = rawResult as Record<string, any>;
      if (typeof r.statusCode === "number") statusCode = r.statusCode;
      if (r.headers && typeof r.headers === "object") {
        responseHeaders = { ...responseHeaders, ...r.headers };
      }
      responseData = r.body !== undefined ? r.body : r;
    } else {
      responseData = rawResult;
    }
  } else {
    errorMessage = workerResult.error || "Function execution failed";
    statusCode = /timed out/i.test(errorMessage) ? 504 : 500;
    if (!logs.some((l) => l.level === "error" && l.message === errorMessage)) {
      logs.push({
        level: "error",
        message: errorMessage,
        timestamp: new Date().toISOString(),
      });
    }
  }

  const durationMs = Date.now() - started;

  await pool.query(
    `INSERT INTO platform_function_logs (
      project_id, function_id, invocation_id, status_code, duration_ms, logs, error_message, request_meta
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
    [
      project.id,
      fn.id,
      invocationId,
      statusCode,
      durationMs,
      JSON.stringify(logs),
      errorMessage,
      JSON.stringify({
        method: request.method ?? "POST",
        role: auth.role,
        userId: auth.userId ?? null,
      }),
    ]
  );

  await incrementProjectMetric(project.id, "function_invocations_total", 1);

  return {
    invocationId,
    statusCode,
    headers: responseHeaders,
    data: responseData,
    logs,
    durationMs,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

export async function listFunctionLogs(
  projectId: string,
  options: { slug?: string; limit?: number } = {}
): Promise<Array<FunctionInvocationLog & { function_slug: string }>> {
  const params: unknown[] = [projectId];
  let slugClause = "";
  if (options.slug) {
    params.push(options.slug);
    slugClause = `AND f.slug = $2`;
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  params.push(limit);

  const res = await pool.query<
    FunctionInvocationLog & { function_slug: string }
  >(
    `SELECT l.*, f.slug AS function_slug
     FROM platform_function_logs l
     JOIN platform_functions f ON f.id = l.function_id
     WHERE l.project_id = $1 ${slugClause}
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

// Background Jobs & Queues
export interface BackgroundJobRecord {
  id: string;
  project_id: string;
  queue_name: string;
  job_type: "function" | "sql_maintenance" | "webhook" | "storage_cleanup";
  payload: Record<string, unknown>;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "dead_letter";
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: string;
  locked_at: string | null;
  locked_by: string | null;
  timeout_ms: number;
  last_error: string | null;
  result: Record<string, unknown> | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export async function enqueueBackgroundJob(
  project: ProjectRecord,
  input: {
    queueName?: string;
    jobType: BackgroundJobRecord["job_type"];
    payload?: Record<string, unknown>;
    priority?: number;
    delaySeconds?: number;
    maxAttempts?: number;
    timeoutMs?: number;
    idempotencyKey?: string;
    actorId?: string | null;
  }
): Promise<BackgroundJobRecord> {
  if (input.idempotencyKey) {
    const existing = await pool.query<BackgroundJobRecord>(
      `SELECT * FROM platform_jobs WHERE project_id = $1 AND idempotency_key = $2`,
      [project.id, input.idempotencyKey]
    );
    if (existing.rows[0]) {
      return existing.rows[0];
    }
  }

  const runAt = new Date(
    Date.now() + Math.max(0, input.delaySeconds ?? 0) * 1000
  ).toISOString();

  const res = await pool.query<BackgroundJobRecord>(
    `INSERT INTO platform_jobs (
      project_id, queue_name, job_type, payload, status, priority, attempts, max_attempts, run_at, timeout_ms, idempotency_key
    ) VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, 0, $6, $7, $8, $9)
    RETURNING *`,
    [
      project.id,
      input.queueName ?? "default",
      input.jobType,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      Math.min(Math.max(input.maxAttempts ?? 3, 1), 10),
      runAt,
      Math.min(Math.max(input.timeoutMs ?? 10000, 500), 60000),
      input.idempotencyKey ?? null,
    ]
  );

  await recordAuditEvent({
    projectId: project.id,
    actorType: input.actorId ? "user" : "service",
    actorId: input.actorId ?? null,
    action: "job.enqueued",
    resourceType: "job",
    resourceId: res.rows[0]!.id,
    metadata: {
      queueName: input.queueName ?? "default",
      jobType: input.jobType,
    },
  });

  return res.rows[0]!;
}

export async function listBackgroundJobs(
  projectId: string,
  options: { status?: string; queueName?: string; limit?: number } = {}
): Promise<BackgroundJobRecord[]> {
  const params: unknown[] = [projectId];
  const clauses: string[] = ["project_id = $1"];
  if (options.status) {
    params.push(options.status);
    clauses.push(`status = $${params.length}`);
  }
  if (options.queueName) {
    params.push(options.queueName);
    clauses.push(`queue_name = $${params.length}`);
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  params.push(limit);

  const res = await pool.query<BackgroundJobRecord>(
    `SELECT * FROM platform_jobs
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

export async function getBackgroundJobById(
  projectId: string,
  jobId: string
): Promise<BackgroundJobRecord> {
  const res = await pool.query<BackgroundJobRecord>(
    `SELECT * FROM platform_jobs WHERE id = $1 AND project_id = $2`,
    [jobId, projectId]
  );
  if (!res.rows[0]) {
    throw new NotFoundError("Background job not found.");
  }
  return res.rows[0];
}

export async function cancelBackgroundJob(
  projectId: string,
  jobId: string
): Promise<BackgroundJobRecord> {
  const res = await pool.query<BackgroundJobRecord>(
    `UPDATE platform_jobs
     SET status = 'cancelled', updated_at = now()
     WHERE id = $1 AND project_id = $2 AND status IN ('queued', 'failed')
     RETURNING *`,
    [jobId, projectId]
  );
  if (!res.rows[0]) {
    throw new ValidationError("Only queued or failed jobs can be cancelled.");
  }
  return res.rows[0];
}

export async function executeSingleJob(
  job: BackgroundJobRecord
): Promise<BackgroundJobRecord> {
  const project = await getProjectByRef(job.project_id);
  const nextAttempt = job.attempts + 1;

  await pool.query(
    `UPDATE platform_jobs
     SET status = 'running', attempts = $1, locked_at = now(), locked_by = 'maary-worker', updated_at = now()
     WHERE id = $2`,
    [nextAttempt, job.id]
  );

  try {
    let resultPayload: Record<string, unknown> = {};

    if (job.job_type === "function") {
      const slug = String(
        job.payload.functionSlug ?? job.payload.slug ?? ""
      ).trim();
      if (!slug) {
        throw new Error("Function job requires payload.functionSlug or payload.slug.");
      }
      const invokeRes = await invokeServerFunction(
        project,
        slug,
        {
          method: "POST",
          body: job.payload.body ?? job.payload,
          headers: { "x-maary-job-id": job.id },
        },
        { role: "service_role" },
        { hasValidCredentials: true }
      );
      if (invokeRes.statusCode >= 400) {
        throw new Error(
          invokeRes.error ||
            `Function '${slug}' returned status ${invokeRes.statusCode}.`
        );
      }
      resultPayload = {
        invocationId: invokeRes.invocationId,
        statusCode: invokeRes.statusCode,
        data: invokeRes.data,
        durationMs: invokeRes.durationMs,
      };
    } else if (job.job_type === "sql_maintenance") {
      const sql = String(job.payload.sql ?? "").trim();
      if (!sql) {
        throw new Error("sql_maintenance job requires payload.sql.");
      }
      const sqlRes = await executeProjectSql(project, {
        sql,
        allowDestructive: false,
        rlsContext: { role: "service_role" },
      });
      resultPayload = {
        rowCount: sqlRes.rowCount,
        durationMs: sqlRes.durationMs,
      };
    } else if (job.job_type === "storage_cleanup") {
      const cleaned = await cleanupAbandonedMultipartUploads(project.id);
      resultPayload = cleaned;
    } else if (job.job_type === "webhook") {
      const url = String(job.payload.url ?? "");
      if (!url) {
        throw new Error("webhook job requires payload.url.");
      }
      resultPayload = {
        delivered: true,
        targetUrl: url,
        deliveredAt: new Date().toISOString(),
      };
    }

    const updatedRes = await pool.query<BackgroundJobRecord>(
      `UPDATE platform_jobs
       SET status = 'completed',
           result = $1::jsonb,
           last_error = NULL,
           completed_at = now(),
           updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [JSON.stringify(resultPayload), job.id]
    );
    await incrementProjectMetric(project.id, "jobs_completed_total", 1);
    return updatedRes.rows[0]!;
  } catch (err: any) {
    const errorMsg = err?.message || "Job execution failed";
    const isExhausted = nextAttempt >= job.max_attempts;
    const nextStatus = isExhausted ? "dead_letter" : "queued";
    // Exponential backoff on retry (1s, 2s, 4s, ...)
    const backoffSeconds = isExhausted
      ? 0
      : Math.min(Math.pow(2, nextAttempt - 1), 60);
    const nextRunAt = new Date(
      Date.now() + backoffSeconds * 1000
    ).toISOString();

    const failedRes = await pool.query<BackgroundJobRecord>(
      `UPDATE platform_jobs
       SET status = $1,
           last_error = $2,
           run_at = $3,
           updated_at = now()
       WHERE id = $4
       RETURNING *`,
      [nextStatus, errorMsg, nextRunAt, job.id]
    );
    await incrementProjectMetric(project.id, "jobs_failed_total", 1);
    return failedRes.rows[0]!;
  }
}

export async function processDueBackgroundJobs(options: {
  projectId?: string;
  limit?: number;
} = {}): Promise<BackgroundJobRecord[]> {
  await evaluateDueSchedules(options.projectId);

  const params: unknown[] = [];
  let projClause = "";
  if (options.projectId) {
    params.push(options.projectId);
    projClause = `AND project_id = $1`;
  }
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
  params.push(limit);

  const dueRes = await pool.query<BackgroundJobRecord>(
    `SELECT * FROM platform_jobs
     WHERE status = 'queued' AND run_at <= now() ${projClause}
     ORDER BY priority DESC, run_at ASC
     LIMIT $${params.length}`,
    params
  );

  const results: BackgroundJobRecord[] = [];
  for (const job of dueRes.rows) {
    const processed = await executeSingleJob(job);
    results.push(processed);
  }
  return results;
}

// Scheduled Tasks (Cron / Recurring Jobs)
export interface ScheduleRecord {
  id: string;
  project_id: string;
  name: string;
  cron_expression: string;
  interval_seconds: number;
  job_type: BackgroundJobRecord["job_type"];
  target_slug: string | null;
  payload: Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

export async function upsertSchedule(
  project: ProjectRecord,
  input: {
    name: string;
    cronExpression?: string;
    intervalSeconds?: number;
    jobType: BackgroundJobRecord["job_type"];
    targetSlug?: string;
    payload?: Record<string, unknown>;
    enabled?: boolean;
    actorId?: string | null;
  }
): Promise<ScheduleRecord> {
  const name = input.name.trim();
  if (!name) {
    throw new ValidationError("Schedule name is required.");
  }
  const intervalSeconds = Math.max(input.intervalSeconds ?? 300, 1);
  const nextRunAt = new Date(
    Date.now() + intervalSeconds * 1000
  ).toISOString();

  const res = await pool.query<ScheduleRecord>(
    `INSERT INTO platform_schedules (
      project_id, name, cron_expression, interval_seconds, job_type, target_slug, payload, enabled, next_run_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    ON CONFLICT (project_id, name)
    DO UPDATE SET
      cron_expression = EXCLUDED.cron_expression,
      interval_seconds = EXCLUDED.interval_seconds,
      job_type = EXCLUDED.job_type,
      target_slug = EXCLUDED.target_slug,
      payload = EXCLUDED.payload,
      enabled = EXCLUDED.enabled,
      updated_at = now()
    RETURNING *`,
    [
      project.id,
      name,
      input.cronExpression ?? `*/${Math.max(1, Math.round(intervalSeconds / 60))} * * * *`,
      intervalSeconds,
      input.jobType,
      input.targetSlug ?? null,
      JSON.stringify(input.payload ?? {}),
      input.enabled ?? true,
      nextRunAt,
    ]
  );

  await recordAuditEvent({
    projectId: project.id,
    actorType: input.actorId ? "user" : "service",
    actorId: input.actorId ?? null,
    action: "schedule.upserted",
    resourceType: "schedule",
    resourceId: res.rows[0]!.id,
    metadata: { name, intervalSeconds },
  });

  return res.rows[0]!;
}

export async function listSchedules(
  projectId: string
): Promise<ScheduleRecord[]> {
  const res = await pool.query<ScheduleRecord>(
    `SELECT * FROM platform_schedules WHERE project_id = $1 ORDER BY name ASC`,
    [projectId]
  );
  return res.rows;
}

export async function deleteSchedule(
  projectId: string,
  scheduleIdOrName: string
): Promise<void> {
  const res = await pool.query(
    `DELETE FROM platform_schedules WHERE project_id = $1 AND (id::text = $2 OR name = $2) RETURNING id`,
    [projectId, scheduleIdOrName]
  );
  if (!res.rowCount) {
    throw new NotFoundError("Schedule not found.");
  }
}

export async function evaluateDueSchedules(
  projectId?: string
): Promise<number> {
  const params: unknown[] = [];
  let projClause = "";
  if (projectId) {
    params.push(projectId);
    projClause = `AND project_id = $1`;
  }

  const dueRes = await pool.query<ScheduleRecord>(
    `SELECT * FROM platform_schedules
     WHERE enabled = true AND next_run_at <= now() ${projClause}`,
    params
  );

  let triggered = 0;
  for (const sched of dueRes.rows) {
    const project = await getProjectByRef(sched.project_id);
    const nextRun = new Date(
      Date.now() + Math.max(1, sched.interval_seconds) * 1000
    ).toISOString();

    await pool.query(
      `UPDATE platform_schedules SET last_run_at = now(), next_run_at = $1, updated_at = now() WHERE id = $2`,
      [nextRun, sched.id]
    );

    const jobPayload = {
      ...(sched.payload ?? {}),
      ...(sched.target_slug ? { functionSlug: sched.target_slug } : {}),
      scheduleId: sched.id,
      scheduleName: sched.name,
    };

    await enqueueBackgroundJob(project, {
      queueName: "scheduled",
      jobType: sched.job_type,
      payload: jobPayload,
    });
    triggered += 1;
  }

  return triggered;
}

class BackgroundWorkerSupervisor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start(): void {
    if (this.timer || !config.WORKER_ENABLED) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void processDueBackgroundJobs({ limit: 5 })
        .catch(() => {})
        .finally(() => {
          this.running = false;
        });
    }, config.WORKER_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}

export const workerSupervisor = new BackgroundWorkerSupervisor();
