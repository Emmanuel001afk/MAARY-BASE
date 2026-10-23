import pg from "pg";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { config } from "../config.js";
import { ForbiddenError } from "../lib/errors.js";
import { quoteIdent } from "../lib/sql-safety.js";

const { Pool } = pg;

export interface QueryResult<R = Record<string, any>> {
  rows: R[];
  rowCount: number | null;
  fields?: Array<{ name: string; dataTypeID?: number }>;
}

export interface DatabaseClient {
  query<R = Record<string, any>>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>>;
  release(): void;
}

export interface RlsExecutionContext {
  schemaName: string;
  dbRoleName?: string;
  userId?: string | null;
  role: "anon" | "authenticated" | "service_role" | string;
  email?: string | null;
  projectId?: string;
  claims?: Record<string, unknown>;
  bypassRls?: boolean;
  statementTimeoutMs?: number;
}

export interface PoolStats {
  engine: "PostgreSQL";
  mode: "external" | "embedded-memory" | "embedded-disk";
  totalConnections: number;
  idleConnections: number;
  waitingCount: number;
  totalQueries: number;
}

class AsyncMutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = this.queue.shift();
        if (next) {
          next();
        } else {
          this.locked = false;
        }
      };
    }
    return new Promise<() => void>((resolvePromise) => {
      this.queue.push(() => {
        let released = false;
        resolvePromise(() => {
          if (released) return;
          released = true;
          const next = this.queue.shift();
          if (next) {
            next();
          } else {
            this.locked = false;
          }
        });
      });
    });
  }

  get waitingCount(): number {
    return this.queue.length;
  }

  get isLocked(): boolean {
    return this.locked;
  }
}

class UnifiedDatabasePool {
  private pgPool: pg.Pool | null = null;
  private pglite: PGlite | null = null;
  private pgliteInitPromise: Promise<PGlite> | null = null;
  private mutex = new AsyncMutex();
  private totalQueries = 0;

  private isPgliteUrl(url: string): boolean {
    return url.startsWith("pglite://") || url === "memory://";
  }

  private async getPglite(): Promise<PGlite> {
    if (this.pglite) return this.pglite;
    if (this.pgliteInitPromise) return this.pgliteInitPromise;

    this.pgliteInitPromise = (async () => {
      const rawTarget = config.DATABASE_URL.replace(/^pglite:\/\//, "");
      const extensions = {
        pgcrypto,
        "uuid-ossp": uuid_ossp,
        pg_trgm,
        hstore,
        ltree,
        citext,
      };
      let instance: PGlite;
      if (
        rawTarget === "memory" ||
        rawTarget === ":memory:" ||
        rawTarget === "" ||
        config.DATABASE_URL === "memory://"
      ) {
        instance = await PGlite.create({ extensions });
      } else {
        const dataDir = resolve(process.cwd(), rawTarget);
        await mkdir(dataDir, { recursive: true });
        instance = await PGlite.create({ dataDir, extensions });
      }
      this.pglite = instance;
      return instance;
    })();

    try {
      return await this.pgliteInitPromise;
    } catch (err) {
      this.pgliteInitPromise = null;
      throw err;
    }
  }

  private getPgPool(): pg.Pool {
    if (!this.pgPool) {
      this.pgPool = new Pool({
        connectionString: config.DATABASE_URL,
        max: config.DATABASE_POOL_MAX,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        application_name: "maary-base-api",
      });
      this.pgPool.on("error", (error) =>
        console.error("Unexpected idle PostgreSQL client error", error)
      );
    }
    return this.pgPool;
  }

  private async runPgliteQuery<R = Record<string, any>>(
    db: PGlite,
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>> {
    this.totalQueries += 1;
    if (values && values.length > 0) {
      const res = await db.query<R>(text, values);
      const count =
        res.affectedRows && res.affectedRows > 0
          ? res.affectedRows
          : res.rows.length;
      return {
        rows: res.rows,
        rowCount: count,
        fields: res.fields,
      };
    }
    const results = await db.exec(text);
    if (!results || results.length === 0) {
      return { rows: [], rowCount: 0, fields: [] };
    }
    const last = results[results.length - 1]!;
    const lastRows = (last.rows ?? []) as R[];
    const count =
      last.affectedRows && last.affectedRows > 0
        ? last.affectedRows
        : lastRows.length;
    return {
      rows: lastRows,
      rowCount: count,
      fields: last.fields,
    };
  }

  async query<R = Record<string, any>>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<R>> {
    if (this.isPgliteUrl(config.DATABASE_URL)) {
      const release = await this.mutex.acquire();
      try {
        const db = await this.getPglite();
        return await this.runPgliteQuery<R>(db, text, values);
      } finally {
        release();
      }
    }
    this.totalQueries += 1;
    const p = this.getPgPool();
    const res = await p.query<R & pg.QueryResultRow>(text, values);
    return {
      rows: res.rows,
      rowCount: res.rowCount,
      fields: res.fields,
    };
  }

  async connect(): Promise<DatabaseClient> {
    if (this.isPgliteUrl(config.DATABASE_URL)) {
      const release = await this.mutex.acquire();
      let db: PGlite;
      try {
        db = await this.getPglite();
      } catch (err) {
        release();
        throw err;
      }
      return {
        query: async <R = Record<string, any>>(
          text: string,
          values?: unknown[]
        ): Promise<QueryResult<R>> => {
          return this.runPgliteQuery<R>(db, text, values);
        },
        release: () => {
          release();
        },
      };
    }

    const client = await this.getPgPool().connect();
    return {
      query: async <R = Record<string, any>>(
        text: string,
        values?: unknown[]
      ): Promise<QueryResult<R>> => {
        this.totalQueries += 1;
        const res = await client.query<R & pg.QueryResultRow>(text, values);
        return {
          rows: res.rows,
          rowCount: res.rowCount,
          fields: res.fields,
        };
      },
      release: () => {
        client.release();
      },
    };
  }

  async end(): Promise<void> {
    if (this.pgPool) {
      const current = this.pgPool;
      this.pgPool = null;
      await current.end();
    }
    if (this.pglite || this.pgliteInitPromise) {
      const release = await this.mutex.acquire();
      try {
        const instance =
          this.pglite ??
          (this.pgliteInitPromise ? await this.pgliteInitPromise : null);
        this.pglite = null;
        this.pgliteInitPromise = null;
        if (instance) {
          await instance.close();
        }
      } finally {
        release();
      }
    }
  }

  getStats(): PoolStats {
    if (this.isPgliteUrl(config.DATABASE_URL)) {
      const isMem =
        config.DATABASE_URL === "pglite://memory" ||
        config.DATABASE_URL === "memory://";
      return {
        engine: "PostgreSQL",
        mode: isMem ? "embedded-memory" : "embedded-disk",
        totalConnections: this.pglite ? 1 : 0,
        idleConnections: this.pglite && !this.mutex.isLocked ? 1 : 0,
        waitingCount: this.mutex.waitingCount,
        totalQueries: this.totalQueries,
      };
    }
    const p = this.pgPool;
    return {
      engine: "PostgreSQL",
      mode: "external",
      totalConnections: p ? p.totalCount : 0,
      idleConnections: p ? p.idleCount : 0,
      waitingCount: p ? p.waitingCount : 0,
      totalQueries: this.totalQueries,
    };
  }
}

export const pool = new UnifiedDatabasePool();

export async function withTransaction<T>(
  fn: (client: DatabaseClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback errors
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function withRlsTransaction<T>(
  ctx: RlsExecutionContext,
  fn: (client: DatabaseClient) => Promise<T>
): Promise<T> {
  return withTransaction(async (client) => {
    const schemaIdent = quoteIdent(ctx.schemaName);
    await client.query(
      `SET LOCAL search_path TO ${schemaIdent}, auth, public`
    );

    const timeoutMs = ctx.statementTimeoutMs ?? config.STATEMENT_TIMEOUT_MS;
    await client.query(`SET LOCAL statement_timeout = ${Number(timeoutMs)}`);

    const sub = ctx.userId ?? "";
    const role = ctx.role || "anon";
    const email = ctx.email ?? "";
    const projectId = ctx.projectId ?? "";
    const claimsJson = JSON.stringify({
      sub: ctx.userId ?? null,
      role,
      email: ctx.email ?? null,
      project_id: ctx.projectId ?? null,
      ...(ctx.claims ?? {}),
    });

    await client.query(
      `SELECT
        set_config('request.jwt.claim.sub', $1, true),
        set_config('request.jwt.claim.role', $2, true),
        set_config('request.jwt.claim.email', $3, true),
        set_config('request.jwt.claim.project_id', $4, true),
        set_config('request.jwt.claims', $5, true)`,
      [sub, role, email, projectId, claimsJson]
    );

    // Always switch to a project-isolated non-superuser PostgreSQL role so the database
    // privilege boundary independently enforces cross-project and control-plane isolation,
    // even for privileged service_role queries.
    const isServiceRole = Boolean(ctx.bypassRls || ctx.role === "service_role");
    const expectedRoleName = ctx.dbRoleName
      ? isServiceRole
        ? ctx.dbRoleName
        : `${ctx.dbRoleName}_rls`
      : "maary_rls_user";
    const targetRoleIdent = quoteIdent(expectedRoleName);
    await client.query(`SET LOCAL ROLE ${targetRoleIdent}`);

    const result = await fn(client);

    const roleCheck = await client.query<{ current_user: string }>(
      "SELECT current_user"
    );
    if (roleCheck.rows[0]?.current_user !== expectedRoleName) {
      throw new ForbiddenError(
        "Database privilege boundary violation: unauthorized role switch detected."
      );
    }

    return result;
  });
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
