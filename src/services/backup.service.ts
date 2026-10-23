import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { assertValidIdentifier, quoteIdent } from "../lib/sql-safety.js";
import { recordAuditEvent } from "./audit.service.js";
import {
  createProjectRlsPolicy,
  ensureProjectSchemaPrivilegesAndTriggers,
  inspectProjectSchema,
  type TableSchemaMetadata,
} from "./database.service.js";
import {
  getProjectByRef,
  listProjectsForUser,
  type ProjectRecord,
} from "./project.service.js";

export interface BackupRecord {
  id: string;
  project_id: string | null;
  backup_type: "project" | "platform_full";
  name: string;
  file_path: string;
  size_bytes: number;
  checksum_sha256: string;
  status: "completed" | "failed" | "restored";
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  restored_at: string | null;
}

interface SequenceSnapshot {
  name: string;
  dataType: string;
  startValue: string;
  minValue: string;
  maxValue: string;
  incrementBy: string;
  cycle: boolean;
  lastValue: string | null;
  isCalled: boolean;
}

interface ConstraintSnapshot {
  tableName: string;
  constraintName: string;
  constraintType: "c" | "u";
  definition: string;
}

interface StoredRoutineSnapshot {
  name: string;
  definition: string;
}

interface StorageObjectSnapshot {
  row: Record<string, unknown>;
  contentBase64: string | null;
}

interface ProjectBackupSnapshot {
  project: ProjectRecord;
  environments: Array<Record<string, unknown>>;
  apiKeys: Array<Record<string, unknown>>;
  secrets: Array<Record<string, unknown>>;
  migrations: Array<Record<string, unknown>>;
  sequences: SequenceSnapshot[];
  tables: Array<{
    schema: TableSchemaMetadata;
    constraints: ConstraintSnapshot[];
    rows: Record<string, unknown>[];
  }>;
  storedRoutines: StoredRoutineSnapshot[];
  rlsPolicies: Array<{
    table_name: string;
    policy_name: string;
    command: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
    using_expression: string | null;
    check_expression: string | null;
  }>;
  functions: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  schedules: Array<Record<string, unknown>>;
  authConfig: Record<string, unknown> | null;
  authUsers: Array<Record<string, unknown>>;
  authIdentities: Array<Record<string, unknown>>;
  realtimeChannels: Array<Record<string, unknown>>;
  storageBuckets: Array<Record<string, unknown>>;
  storagePolicies: Array<Record<string, unknown>>;
  storageObjects: StorageObjectSnapshot[];
}

interface PlatformBackupState {
  platformUsers: Array<Record<string, unknown>>;
  projectMembers: Array<Record<string, unknown>>;
}

interface BackupBundle {
  formatVersion: "2.0";
  createdAt: string;
  backupType: "project" | "platform_full";
  platformState?: PlatformBackupState;
  projects: ProjectBackupSnapshot[];
}

function normalizeBackupRow(row: any): BackupRecord {
  return {
    ...row,
    size_bytes: Number(row.size_bytes),
  };
}

function formatColumnTypeForRestore(col: {
  dataType: string;
  udtName: string;
}): string {
  const udt = col.udtName.toLowerCase();
  if (udt === "int4") return "integer";
  if (udt === "int8") return "bigint";
  if (udt === "int2") return "smallint";
  if (udt === "bool") return "boolean";
  if (udt === "float8") return "double precision";
  if (udt === "float4") return "real";
  if (udt === "_text") return "text[]";
  if (udt === "_int4") return "integer[]";
  if (udt === "_uuid") return "uuid[]";
  return col.dataType;
}

async function captureProjectSnapshot(
  project: ProjectRecord
): Promise<ProjectBackupSnapshot> {
  const tableSchemas = await inspectProjectSchema(project);
  const schemaIdent = quoteIdent(project.schema_name);

  // Capture sequences and their live state
  const seqMetaRes = await pool.query<{
    sequence_name: string;
    data_type: string;
    start_value: string;
    minimum_value: string;
    maximum_value: string;
    increment: string;
    cycle_option: string;
  }>(
    `SELECT sequence_name, data_type, start_value, minimum_value, maximum_value, increment, cycle_option
     FROM information_schema.sequences
     WHERE sequence_schema = $1
     ORDER BY sequence_name ASC`,
    [project.schema_name]
  );

  const sequences: SequenceSnapshot[] = [];
  for (const seq of seqMetaRes.rows) {
    const seqIdent = quoteIdent(seq.sequence_name);
    let lastValue: string | null = null;
    let isCalled = false;
    try {
      const stateRes = await pool.query<{
        last_value: string | number;
        is_called: boolean;
      }>(`SELECT last_value::text AS last_value, is_called FROM ${schemaIdent}.${seqIdent}`);
      if (stateRes.rows[0]) {
        lastValue = String(stateRes.rows[0].last_value);
        isCalled = Boolean(stateRes.rows[0].is_called);
      }
    } catch {
      // Ignore if sequence cannot be queried directly
    }
    sequences.push({
      name: seq.sequence_name,
      dataType: seq.data_type || "bigint",
      startValue: String(seq.start_value ?? "1"),
      minValue: String(seq.minimum_value ?? "1"),
      maxValue: String(seq.maximum_value ?? "9223372036854775807"),
      incrementBy: String(seq.increment ?? "1"),
      cycle: seq.cycle_option === "YES",
      lastValue,
      isCalled,
    });
  }

  // Capture CHECK and UNIQUE constraints
  const constraintsRes = await pool.query<{
    table_name: string;
    constraint_name: string;
    contype: "c" | "u";
    definition: string;
  }>(
    `SELECT
       rel.relname AS table_name,
       con.conname AS constraint_name,
       con.contype AS contype,
       pg_get_constraintdef(con.oid) AS definition
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = $1
       AND con.contype IN ('c', 'u')
     ORDER BY rel.relname ASC, con.conname ASC`,
    [project.schema_name]
  );

  const tables: ProjectBackupSnapshot["tables"] = [];
  for (const ts of tableSchemas) {
    const tblIdent = quoteIdent(ts.name);
    const rowsRes = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${schemaIdent}.${tblIdent}`
    );
    const tblConstraints = constraintsRes.rows
      .filter((c) => c.table_name === ts.name)
      .map((c) => ({
        tableName: c.table_name,
        constraintName: c.constraint_name,
        constraintType: c.contype,
        definition: c.definition,
      }));
    tables.push({
      schema: ts,
      constraints: tblConstraints,
      rows: rowsRes.rows,
    });
  }

  // Capture user-defined SQL/PLpgSQL functions in project schema
  const routinesRes = await pool.query<{
    proname: string;
    definition: string;
  }>(
    `SELECT p.proname, pg_get_functiondef(p.oid) AS definition
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.prokind = 'f'
     ORDER BY p.proname ASC`,
    [project.schema_name]
  );

  const [
    envRes,
    keysRes,
    secretsRes,
    migrationsRes,
    polRes,
    fnRes,
    jobsRes,
    schedulesRes,
    authCfgRes,
    usersRes,
    identitiesRes,
    channelsRes,
    bucketsRes,
    storagePolRes,
    storageObjRes,
  ] = await Promise.all([
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_environments WHERE project_id = $1 ORDER BY created_at ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_api_keys WHERE project_id = $1 ORDER BY created_at ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_secrets WHERE project_id = $1 ORDER BY name ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_project_migrations WHERE project_id = $1 ORDER BY version ASC`,
      [project.id]
    ),
    pool.query<{
      table_name: string;
      policy_name: string;
      command: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
      using_expression: string | null;
      check_expression: string | null;
    }>(
      `SELECT table_name, policy_name, command, using_expression, check_expression
       FROM platform_rls_policies WHERE project_id = $1`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_functions WHERE project_id = $1 ORDER BY slug ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_jobs WHERE project_id = $1 ORDER BY created_at ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_schedules WHERE project_id = $1 ORDER BY name ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_auth_configs WHERE project_id = $1`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM project_auth_users WHERE project_id = $1 ORDER BY created_at ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM project_auth_identities WHERE project_id = $1 ORDER BY created_at ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_realtime_channels WHERE project_id = $1 ORDER BY topic ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_storage_buckets WHERE project_id = $1 ORDER BY name ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_storage_policies WHERE project_id = $1 ORDER BY name ASC`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT * FROM platform_storage_objects WHERE project_id = $1 ORDER BY path ASC`,
      [project.id]
    ),
  ]);

  const storageObjects: StorageObjectSnapshot[] = [];
  for (const objRow of storageObjRes.rows) {
    let contentBase64: string | null = null;
    try {
      const diskPath = resolve(config.STORAGE_DIR, String(objRow.storage_key));
      const buf = await readFile(diskPath);
      contentBase64 = buf.toString("base64");
    } catch {
      contentBase64 = null;
    }
    storageObjects.push({ row: objRow, contentBase64 });
  }

  return {
    project,
    environments: envRes.rows,
    apiKeys: keysRes.rows,
    secrets: secretsRes.rows,
    migrations: migrationsRes.rows,
    sequences,
    tables,
    storedRoutines: routinesRes.rows.map((r) => ({
      name: r.proname,
      definition: r.definition,
    })),
    rlsPolicies: polRes.rows,
    functions: fnRes.rows,
    jobs: jobsRes.rows,
    schedules: schedulesRes.rows,
    authConfig: authCfgRes.rows[0] ?? null,
    authUsers: usersRes.rows,
    authIdentities: identitiesRes.rows,
    realtimeChannels: channelsRes.rows,
    storageBuckets: bucketsRes.rows,
    storagePolicies: storagePolRes.rows,
    storageObjects,
  };
}

export async function createDatabaseBackup(options: {
  projectId?: string;
  name?: string;
  actorId?: string | null;
}): Promise<BackupRecord> {
  const backupDir = resolve(config.BACKUP_DIR);
  await mkdir(backupDir, { recursive: true });

  const backupType = options.projectId ? "project" : "platform_full";
  const projectsToBackup: ProjectRecord[] = options.projectId
    ? [await getProjectByRef(options.projectId)]
    : await listProjectsForUser(null);

  const snapshots: ProjectBackupSnapshot[] = [];
  for (const p of projectsToBackup) {
    snapshots.push(await captureProjectSnapshot(p));
  }

  let platformState: PlatformBackupState | undefined;
  if (backupType === "platform_full") {
    const [uRes, mRes] = await Promise.all([
      pool.query<Record<string, unknown>>(
        `SELECT * FROM platform_users ORDER BY created_at ASC`
      ),
      pool.query<Record<string, unknown>>(
        `SELECT * FROM platform_project_members ORDER BY created_at ASC`
      ),
    ]);
    platformState = {
      platformUsers: uRes.rows,
      projectMembers: mRes.rows,
    };
  }

  const bundle: BackupBundle = {
    formatVersion: "2.0",
    createdAt: new Date().toISOString(),
    backupType,
    ...(platformState ? { platformState } : {}),
    projects: snapshots,
  };

  const serialized = JSON.stringify(bundle, null, 2);
  const dataBuf = Buffer.from(serialized, "utf8");
  const checksum = createHash("sha256").update(dataBuf).digest("hex");

  const slugLabel =
    options.projectId && projectsToBackup[0]
      ? projectsToBackup[0].slug
      : "platform-full";
  const fileName = `${Date.now()}-${slugLabel}.backup.json`;
  const filePath = join(backupDir, fileName);

  await writeFile(filePath, dataBuf);

  const totalTables = snapshots.reduce((acc, s) => acc + s.tables.length, 0);
  const totalRows = snapshots.reduce(
    (acc, s) => acc + s.tables.reduce((rAcc, t) => rAcc + t.rows.length, 0),
    0
  );
  const totalFunctions = snapshots.reduce(
    (acc, s) => acc + s.functions.length,
    0
  );
  const totalAuthUsers = snapshots.reduce(
    (acc, s) => acc + s.authUsers.length,
    0
  );
  const totalStorageObjects = snapshots.reduce(
    (acc, s) => acc + s.storageObjects.length,
    0
  );

  const res = await pool.query(
    `INSERT INTO platform_backups (
      project_id, backup_type, name, file_path, size_bytes, checksum_sha256, status, metadata, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb, $8)
    RETURNING *`,
    [
      options.projectId ?? null,
      backupType,
      options.name?.trim() ||
        `Backup ${slugLabel} (${new Date().toISOString()})`,
      filePath,
      dataBuf.byteLength,
      checksum,
      JSON.stringify({
        formatVersion: "2.0",
        projectCount: snapshots.length,
        tableCount: totalTables,
        rowCount: totalRows,
        functionCount: totalFunctions,
        authUserCount: totalAuthUsers,
        storageObjectCount: totalStorageObjects,
      }),
      options.actorId ?? null,
    ]
  );

  await recordAuditEvent({
    projectId: options.projectId ?? null,
    actorType: options.actorId ? "user" : "system",
    actorId: options.actorId ?? null,
    action: "backup.created",
    resourceType: "backup",
    resourceId: res.rows[0]!.id,
    metadata: {
      backupType,
      checksum,
      sizeBytes: dataBuf.byteLength,
      tableCount: totalTables,
      rowCount: totalRows,
      functionCount: totalFunctions,
      authUserCount: totalAuthUsers,
      storageObjectCount: totalStorageObjects,
    },
  });

  return normalizeBackupRow(res.rows[0]);
}

export async function listDatabaseBackups(
  projectId?: string
): Promise<BackupRecord[]> {
  const params: unknown[] = [];
  let whereSql = "";
  if (projectId) {
    params.push(projectId);
    whereSql = `WHERE project_id = $1`;
  }
  const res = await pool.query(
    `SELECT * FROM platform_backups ${whereSql} ORDER BY created_at DESC`,
    params
  );
  return res.rows.map(normalizeBackupRow);
}

export async function getDatabaseBackupById(
  backupId: string
): Promise<BackupRecord> {
  const res = await pool.query(`SELECT * FROM platform_backups WHERE id = $1`, [
    backupId,
  ]);
  if (!res.rows[0]) {
    throw new NotFoundError("Backup record not found.");
  }
  return normalizeBackupRow(res.rows[0]);
}

export async function verifyBackupIntegrity(backupId: string): Promise<{
  backup: BackupRecord;
  valid: boolean;
  actualChecksum: string;
  expectedChecksum: string;
}> {
  const backup = await getDatabaseBackupById(backupId);
  let buf: Buffer;
  try {
    buf = await readFile(backup.file_path);
  } catch {
    throw new NotFoundError(
      `Backup file not found on disk at '${backup.file_path}'.`
    );
  }
  const actualChecksum = createHash("sha256").update(buf).digest("hex");
  return {
    backup,
    valid: actualChecksum === backup.checksum_sha256,
    actualChecksum,
    expectedChecksum: backup.checksum_sha256,
  };
}

export async function restoreDatabaseBackup(
  backupId: string,
  options: { actorId?: string | null } = {}
): Promise<{
  backup: BackupRecord;
  restoredProjects: number;
  restoredTables: number;
  restoredRows: number;
  restoredFunctions: number;
  restoredAuthUsers: number;
  restoredStorageObjects: number;
}> {
  const verification = await verifyBackupIntegrity(backupId);
  if (!verification.valid) {
    throw new ValidationError(
      `Backup integrity check failed: expected SHA-256 ${verification.expectedChecksum}, got ${verification.actualChecksum}. Refusing to restore corrupted backup.`
    );
  }

  const rawContent = await readFile(verification.backup.file_path, "utf8");
  const bundle = JSON.parse(rawContent) as BackupBundle;

  let restoredTables = 0;
  let restoredRows = 0;
  let restoredFunctions = 0;
  let restoredAuthUsers = 0;
  let restoredStorageObjects = 0;

  // 1. Restore platform control-plane users if included in platform_full backup
  if (bundle.platformState?.platformUsers) {
    await withTransaction(async (client) => {
      for (const u of bundle.platformState!.platformUsers) {
        await client.query(
          `INSERT INTO platform_users (id, email, password_hash, name, is_superadmin, status, last_login_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO UPDATE SET
             email = EXCLUDED.email,
             password_hash = EXCLUDED.password_hash,
             name = EXCLUDED.name,
             status = EXCLUDED.status,
             updated_at = now()`,
          [
            u.id,
            u.email,
            u.password_hash,
            u.name ?? "",
            Boolean(u.is_superadmin),
            u.status ?? "active",
            u.last_login_at ?? null,
            u.created_at ?? new Date().toISOString(),
            u.updated_at ?? new Date().toISOString(),
          ]
        );
      }
    });
  }

  // 2. Restore each project completely
  for (const snap of bundle.projects) {
    const p = snap.project;
    const dbRoleName =
      p.db_role_name ||
      `role_${p.slug.replace(/[^a-z0-9_]/g, "_").slice(0, 48)}`;
    const rlsRoleName = `${dbRoleName}_rls`;
    assertValidIdentifier(dbRoleName, "role");
    assertValidIdentifier(rlsRoleName, "role");
    const roleIdent = quoteIdent(dbRoleName);
    const rlsRoleIdent = quoteIdent(rlsRoleName);
    const schemaIdent = quoteIdent(p.schema_name);

    await withTransaction(async (client) => {
      // Ensure project roles, schema, and platform_projects record exist
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${dbRoleName}') THEN
            CREATE ROLE ${roleIdent} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
          END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${rlsRoleName}') THEN
            CREATE ROLE ${rlsRoleIdent} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
          END IF;
        END
        $$;
      `);
      await client.query(
        `CREATE SCHEMA IF NOT EXISTS ${schemaIdent} AUTHORIZATION ${roleIdent}`
      );
      await client.query(`ALTER SCHEMA ${schemaIdent} OWNER TO ${roleIdent}`);

      await client.query(
        `INSERT INTO platform_projects (
          id, slug, name, description, schema_name, db_role_name, owner_id, status, settings, quotas, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, now())
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          status = EXCLUDED.status,
          settings = EXCLUDED.settings,
          quotas = EXCLUDED.quotas,
          updated_at = now()`,
        [
          p.id,
          p.slug,
          p.name,
          p.description ?? "",
          p.schema_name,
          dbRoleName,
          p.owner_id ?? null,
          p.status ?? "active",
          JSON.stringify(p.settings ?? {}),
          JSON.stringify(p.quotas ?? {}),
          p.created_at ?? new Date().toISOString(),
        ]
      );

      // Restore environments
      for (const env of snap.environments ?? []) {
        await client.query(
          `INSERT INTO platform_environments (id, project_id, name, slug, is_production, config, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
           ON CONFLICT (project_id, name) DO UPDATE SET
             slug = EXCLUDED.slug,
             is_production = EXCLUDED.is_production,
             config = EXCLUDED.config,
             updated_at = now()`,
          [
            env.id,
            p.id,
            env.name,
            env.slug ?? "development",
            Boolean(env.is_production),
            JSON.stringify(env.config ?? {}),
            env.created_at ?? new Date().toISOString(),
          ]
        );
      }

      // Restore API keys
      for (const key of snap.apiKeys ?? []) {
        await client.query(
          `INSERT INTO platform_api_keys (
            id, project_id, environment_id, name, role, key_prefix, key_hash, encrypted_key, scopes, rate_limit_per_min, expires_at, revoked_at, last_used_at, created_by, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14, $15)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            revoked_at = EXCLUDED.revoked_at,
            scopes = EXCLUDED.scopes,
            rate_limit_per_min = EXCLUDED.rate_limit_per_min`,
          [
            key.id,
            p.id,
            key.environment_id ?? null,
            key.name,
            key.role,
            key.key_prefix,
            key.key_hash,
            key.encrypted_key ? JSON.stringify(key.encrypted_key) : null,
            JSON.stringify(key.scopes ?? ["*"]),
            Number(key.rate_limit_per_min ?? 600),
            key.expires_at ?? null,
            key.revoked_at ?? null,
            key.last_used_at ?? null,
            key.created_by ?? null,
            key.created_at ?? new Date().toISOString(),
          ]
        );
      }

      // Restore encrypted secrets
      for (const sec of snap.secrets ?? []) {
        await client.query(
          `INSERT INTO platform_secrets (
            id, project_id, environment_id, name, encrypted_value, iv, auth_tag, description, version, updated_by, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
          ON CONFLICT (id) DO UPDATE SET
            encrypted_value = EXCLUDED.encrypted_value,
            iv = EXCLUDED.iv,
            auth_tag = EXCLUDED.auth_tag,
            version = EXCLUDED.version,
            updated_at = now()`,
          [
            sec.id,
            p.id,
            sec.environment_id ?? null,
            sec.name,
            sec.encrypted_value,
            sec.iv,
            sec.auth_tag,
            sec.description ?? "",
            Number(sec.version ?? 1),
            sec.updated_by ?? null,
            sec.created_at ?? new Date().toISOString(),
          ]
        );
      }

      // Restore project migrations history
      for (const mig of snap.migrations ?? []) {
        await client.query(
          `INSERT INTO platform_project_migrations (
            id, project_id, version, name, up_sql, down_sql, checksum, status, applied_by, applied_at, rolled_back_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (project_id, version) DO UPDATE SET
            status = EXCLUDED.status,
            rolled_back_at = EXCLUDED.rolled_back_at`,
          [
            mig.id,
            p.id,
            mig.version,
            mig.name,
            mig.up_sql,
            mig.down_sql ?? "",
            mig.checksum,
            mig.status ?? "applied",
            mig.applied_by ?? null,
            mig.applied_at ?? new Date().toISOString(),
            mig.rolled_back_at ?? null,
          ]
        );
      }

      // Restore sequences first so table column defaults referencing nextval(...) succeed
      await client.query(`SET LOCAL search_path TO ${schemaIdent}, auth, public`);
      for (const seq of snap.sequences ?? []) {
        const seqIdent = quoteIdent(seq.name);
        await client.query(
          `CREATE SEQUENCE IF NOT EXISTS ${schemaIdent}.${seqIdent}
           INCREMENT BY ${Number(seq.incrementBy || 1)}
           MINVALUE ${Number(seq.minValue || 1)}
           START WITH ${Number(seq.startValue || 1)}
           ${seq.cycle ? "CYCLE" : "NO CYCLE"}`
        );
      }

      // Recreate tables with defaults, primary keys, and columns
      for (const tbl of snap.tables) {
        const tblIdent = quoteIdent(tbl.schema.name);
        const pkCols = tbl.schema.primaryKeys ?? [];
        const singlePk = pkCols.length === 1 ? pkCols[0] : null;
        const colDefs = tbl.schema.columns.map((c) => {
          const typeStr = formatColumnTypeForRestore(c);
          const pkClause = singlePk === c.name ? " PRIMARY KEY" : "";
          const nnClause = !c.isNullable && singlePk !== c.name ? " NOT NULL" : "";
          const defClause =
            c.defaultValue !== null && c.defaultValue !== undefined
              ? ` DEFAULT ${c.defaultValue}`
              : "";
          return `${quoteIdent(c.name)} ${typeStr}${defClause}${pkClause}${nnClause}`;
        });
        if (pkCols.length > 1) {
          colDefs.push(
            `PRIMARY KEY (${pkCols.map((k) => quoteIdent(k)).join(", ")})`
          );
        }

        await client.query(
          `CREATE TABLE IF NOT EXISTS ${schemaIdent}.${tblIdent} (${colDefs.join(", ")})`
        );

        // Ensure any columns dropped after the backup are re-added
        for (const c of tbl.schema.columns) {
          const typeStr = formatColumnTypeForRestore(c);
          const defClause =
            c.defaultValue !== null && c.defaultValue !== undefined
              ? ` DEFAULT ${c.defaultValue}`
              : "";
          await client.query(
            `ALTER TABLE ${schemaIdent}.${tblIdent} ADD COLUMN IF NOT EXISTS ${quoteIdent(c.name)} ${typeStr}${defClause}`
          );
        }

        await client.query(`TRUNCATE TABLE ${schemaIdent}.${tblIdent} CASCADE`);
        restoredTables += 1;
      }

      // Insert table rows
      for (const tbl of snap.tables) {
        const tblIdent = quoteIdent(tbl.schema.name);
        for (const row of tbl.rows) {
          const keys = Object.keys(row);
          if (keys.length === 0) continue;
          const colIdents = keys.map((k) => quoteIdent(k)).join(", ");
          const params: unknown[] = [];
          const placeholders = keys.map((k) => {
            const v = row[k];
            params.push(
              v !== null && typeof v === "object" ? JSON.stringify(v) : v
            );
            return `$${params.length}`;
          });
          await client.query(
            `INSERT INTO ${schemaIdent}.${tblIdent} (${colIdents}) VALUES (${placeholders.join(", ")})`,
            params
          );
          restoredRows += 1;
        }
      }

      // Restore CHECK and UNIQUE constraints, Foreign Keys, Indexes, and RLS flags
      for (const tbl of snap.tables) {
        const tblIdent = quoteIdent(tbl.schema.name);

        for (const con of tbl.constraints ?? []) {
          const conIdent = quoteIdent(con.constraintName);
          const exists = await client.query(
            `SELECT 1 FROM pg_constraint c
             JOIN pg_class r ON r.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = r.relnamespace
             WHERE n.nspname = $1 AND r.relname = $2 AND c.conname = $3`,
            [p.schema_name, tbl.schema.name, con.constraintName]
          );
          if (!exists.rowCount) {
            await client.query(
              `ALTER TABLE ${schemaIdent}.${tblIdent} ADD CONSTRAINT ${conIdent} ${con.definition}`
            );
          }
        }

        for (const fk of tbl.schema.foreignKeys ?? []) {
          const fkIdent = quoteIdent(fk.constraintName);
          const exists = await client.query(
            `SELECT 1 FROM pg_constraint c
             JOIN pg_class r ON r.oid = c.conrelid
             JOIN pg_namespace n ON n.oid = r.relnamespace
             WHERE n.nspname = $1 AND r.relname = $2 AND c.conname = $3`,
            [p.schema_name, tbl.schema.name, fk.constraintName]
          );
          if (!exists.rowCount) {
            const targetSchemaIdent = quoteIdent(
              fk.foreignTableSchema || p.schema_name
            );
            const targetTableIdent = quoteIdent(fk.foreignTableName);
            const targetColIdent = quoteIdent(fk.foreignColumnName);
            const onDelete = fk.onDelete || "NO ACTION";
            const onUpdate = fk.onUpdate || "NO ACTION";
            await client.query(
              `ALTER TABLE ${schemaIdent}.${tblIdent}
               ADD CONSTRAINT ${fkIdent}
               FOREIGN KEY (${quoteIdent(fk.columnName)})
               REFERENCES ${targetSchemaIdent}.${targetTableIdent}(${targetColIdent})
               ON DELETE ${onDelete} ON UPDATE ${onUpdate}`
            );
          }
        }

        for (const idx of tbl.schema.indexes ?? []) {
          if (idx.name.endsWith("_pkey")) continue;
          const safeIndexDef = idx.definition.replace(
            /^CREATE\s+(UNIQUE\s+)?INDEX\s+/i,
            "CREATE $1INDEX IF NOT EXISTS "
          );
          await client.query(safeIndexDef);
        }

        if (tbl.schema.rlsEnabled) {
          await client.query(
            `ALTER TABLE ${schemaIdent}.${tblIdent} ENABLE ROW LEVEL SECURITY`
          );
          if (tbl.schema.rlsForced) {
            await client.query(
              `ALTER TABLE ${schemaIdent}.${tblIdent} FORCE ROW LEVEL SECURITY`
            );
          } else {
            await client.query(
              `ALTER TABLE ${schemaIdent}.${tblIdent} NO FORCE ROW LEVEL SECURITY`
            );
          }
        } else {
          await client.query(
            `ALTER TABLE ${schemaIdent}.${tblIdent} DISABLE ROW LEVEL SECURITY`
          );
        }
      }

      // Restore sequence values
      for (const seq of snap.sequences ?? []) {
        if (seq.lastValue !== null && seq.lastValue !== undefined) {
          const fqSeq = `${schemaIdent}.${quoteIdent(seq.name)}`;
          await client.query(`SELECT setval($1, $2::bigint, $3)`, [
            fqSeq,
            seq.lastValue,
            Boolean(seq.isCalled),
          ]);
        }
      }

      // Restore stored SQL/PLpgSQL routines in project schema
      for (const routine of snap.storedRoutines ?? []) {
        if (routine.definition) {
          await client.query(routine.definition);
        }
      }

      // Restore Project Auth Configuration, Users, and OAuth Identities
      if (snap.authConfig) {
        const ac = snap.authConfig;
        await client.query(
          `INSERT INTO platform_auth_configs (
            project_id, allow_public_signup, require_email_verification, password_min_length, access_token_ttl_seconds, refresh_token_ttl_seconds, jwt_secret_encrypted, oauth_providers, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, now())
          ON CONFLICT (project_id) DO UPDATE SET
            allow_public_signup = EXCLUDED.allow_public_signup,
            require_email_verification = EXCLUDED.require_email_verification,
            password_min_length = EXCLUDED.password_min_length,
            access_token_ttl_seconds = EXCLUDED.access_token_ttl_seconds,
            refresh_token_ttl_seconds = EXCLUDED.refresh_token_ttl_seconds,
            jwt_secret_encrypted = EXCLUDED.jwt_secret_encrypted,
            oauth_providers = EXCLUDED.oauth_providers,
            updated_at = now()`,
          [
            p.id,
            Boolean(ac.allow_public_signup ?? true),
            Boolean(ac.require_email_verification ?? false),
            Number(ac.password_min_length ?? 8),
            Number(ac.access_token_ttl_seconds ?? 3600),
            Number(ac.refresh_token_ttl_seconds ?? 604800),
            ac.jwt_secret_encrypted
              ? JSON.stringify(ac.jwt_secret_encrypted)
              : null,
            JSON.stringify(ac.oauth_providers ?? {}),
          ]
        );
      }

      if (Array.isArray(snap.authUsers)) {
        const backedUpUserIds = snap.authUsers.map((u) => String(u.id));
        if (backedUpUserIds.length > 0) {
          await client.query(
            `DELETE FROM project_auth_users WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))`,
            [p.id, backedUpUserIds]
          );
        } else {
          await client.query(
            `DELETE FROM project_auth_users WHERE project_id = $1`,
            [p.id]
          );
        }
        for (const u of snap.authUsers) {
          await client.query(
            `INSERT INTO project_auth_users (
              id, project_id, email, phone, password_hash, email_verified, email_verified_at, role, status, user_metadata, app_metadata, last_sign_in_at, banned_until, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, now())
            ON CONFLICT (id) DO UPDATE SET
              email = EXCLUDED.email,
              phone = EXCLUDED.phone,
              password_hash = EXCLUDED.password_hash,
              email_verified = EXCLUDED.email_verified,
              email_verified_at = EXCLUDED.email_verified_at,
              role = EXCLUDED.role,
              status = EXCLUDED.status,
              user_metadata = EXCLUDED.user_metadata,
              app_metadata = EXCLUDED.app_metadata,
              banned_until = EXCLUDED.banned_until,
              updated_at = now()`,
            [
              u.id,
              p.id,
              u.email,
              u.phone ?? null,
              u.password_hash ?? null,
              Boolean(u.email_verified),
              u.email_verified_at ?? null,
              u.role ?? "authenticated",
              u.status ?? "active",
              JSON.stringify(u.user_metadata ?? {}),
              JSON.stringify(u.app_metadata ?? {}),
              u.last_sign_in_at ?? null,
              u.banned_until ?? null,
              u.created_at ?? new Date().toISOString(),
            ]
          );
          restoredAuthUsers += 1;
        }
      }

      for (const ident of snap.authIdentities ?? []) {
        await client.query(
          `INSERT INTO project_auth_identities (
            id, project_id, user_id, provider, provider_id, identity_data, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now())
          ON CONFLICT (project_id, provider, provider_id) DO UPDATE SET
            identity_data = EXCLUDED.identity_data,
            updated_at = now()`,
          [
            ident.id,
            p.id,
            ident.user_id,
            ident.provider,
            ident.provider_id,
            JSON.stringify(ident.identity_data ?? {}),
            ident.created_at ?? new Date().toISOString(),
          ]
        );
      }

      // Restore Server Functions
      if (Array.isArray(snap.functions)) {
        const fnSlugs = snap.functions.map((f) => String(f.slug));
        if (fnSlugs.length > 0) {
          await client.query(
            `DELETE FROM platform_functions WHERE project_id = $1 AND NOT (slug = ANY($2::text[]))`,
            [p.id, fnSlugs]
          );
        } else {
          await client.query(
            `DELETE FROM platform_functions WHERE project_id = $1`,
            [p.id]
          );
        }
        for (const fn of snap.functions) {
          await client.query(
            `INSERT INTO platform_functions (
              id, project_id, slug, name, description, code, entrypoint, version, status, verify_jwt, timeout_ms, env_vars, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, now())
            ON CONFLICT (project_id, slug) DO UPDATE SET
              name = EXCLUDED.name,
              description = EXCLUDED.description,
              code = EXCLUDED.code,
              entrypoint = EXCLUDED.entrypoint,
              version = EXCLUDED.version,
              status = EXCLUDED.status,
              verify_jwt = EXCLUDED.verify_jwt,
              timeout_ms = EXCLUDED.timeout_ms,
              env_vars = EXCLUDED.env_vars,
              updated_at = now()`,
            [
              fn.id ?? createHash("md5").update(`${p.id}:${fn.slug}`).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5"),
              p.id,
              fn.slug,
              fn.name ?? fn.slug,
              fn.description ?? "",
              fn.code,
              fn.entrypoint ?? "handler",
              Number(fn.version ?? 1),
              fn.status ?? "active",
              Boolean(fn.verify_jwt ?? true),
              Number(fn.timeout_ms ?? 2000),
              JSON.stringify(fn.env_vars ?? {}),
              fn.created_at ?? new Date().toISOString(),
            ]
          );
          restoredFunctions += 1;
        }
      }

      // Restore Background Jobs & Schedules
      for (const job of snap.jobs ?? []) {
        await client.query(
          `INSERT INTO platform_jobs (
            id, project_id, queue_name, job_type, payload, status, priority, attempts, max_attempts, run_at, timeout_ms, last_error, result, idempotency_key, created_at, updated_at, completed_at
          ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, now(), $16)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            attempts = EXCLUDED.attempts,
            result = EXCLUDED.result,
            last_error = EXCLUDED.last_error,
            updated_at = now()`,
          [
            job.id,
            p.id,
            job.queue_name ?? "default",
            job.job_type ?? "function",
            JSON.stringify(job.payload ?? {}),
            job.status ?? "queued",
            Number(job.priority ?? 0),
            Number(job.attempts ?? 0),
            Number(job.max_attempts ?? 3),
            job.run_at ?? new Date().toISOString(),
            Number(job.timeout_ms ?? 10000),
            job.last_error ?? null,
            job.result ? JSON.stringify(job.result) : null,
            job.idempotency_key ?? null,
            job.created_at ?? new Date().toISOString(),
            job.completed_at ?? null,
          ]
        );
      }

      for (const sched of snap.schedules ?? []) {
        await client.query(
          `INSERT INTO platform_schedules (
            id, project_id, name, cron_expression, interval_seconds, job_type, target_slug, payload, enabled, last_run_at, next_run_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, now())
          ON CONFLICT (project_id, name) DO UPDATE SET
            cron_expression = EXCLUDED.cron_expression,
            interval_seconds = EXCLUDED.interval_seconds,
            payload = EXCLUDED.payload,
            enabled = EXCLUDED.enabled,
            updated_at = now()`,
          [
            sched.id,
            p.id,
            sched.name,
            sched.cron_expression ?? "*/5 * * * *",
            Number(sched.interval_seconds ?? 300),
            sched.job_type ?? "function",
            sched.target_slug ?? null,
            JSON.stringify(sched.payload ?? {}),
            Boolean(sched.enabled ?? true),
            sched.last_run_at ?? null,
            sched.next_run_at ?? new Date().toISOString(),
            sched.created_at ?? new Date().toISOString(),
          ]
        );
      }

      // Restore Realtime Channels
      for (const ch of snap.realtimeChannels ?? []) {
        await client.query(
          `INSERT INTO platform_realtime_channels (id, project_id, topic, is_private, config, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (project_id, topic) DO UPDATE SET
             is_private = EXCLUDED.is_private,
             config = EXCLUDED.config`,
          [
            ch.id,
            p.id,
            ch.topic,
            Boolean(ch.is_private),
            JSON.stringify(ch.config ?? {}),
            ch.created_at ?? new Date().toISOString(),
          ]
        );
      }

      // Restore Storage Buckets, Policies, and Objects
      for (const b of snap.storageBuckets ?? []) {
        await client.query(
          `INSERT INTO platform_storage_buckets (
            id, project_id, name, public, file_size_limit_bytes, quota_bytes, allowed_mime_types, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
          ON CONFLICT (project_id, name) DO UPDATE SET
            public = EXCLUDED.public,
            file_size_limit_bytes = EXCLUDED.file_size_limit_bytes,
            quota_bytes = EXCLUDED.quota_bytes,
            allowed_mime_types = EXCLUDED.allowed_mime_types,
            updated_at = now()`,
          [
            b.id,
            p.id,
            b.name,
            Boolean(b.public),
            Number(b.file_size_limit_bytes ?? 52428800),
            Number(b.quota_bytes ?? 104857600),
            JSON.stringify(b.allowed_mime_types ?? []),
            b.created_at ?? new Date().toISOString(),
          ]
        );
      }

      for (const sp of snap.storagePolicies ?? []) {
        await client.query(
          `INSERT INTO platform_storage_policies (
            id, project_id, bucket_id, name, operation, roles, path_prefix, allow_owner_only, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
          ON CONFLICT (bucket_id, name) DO UPDATE SET
            operation = EXCLUDED.operation,
            roles = EXCLUDED.roles,
            path_prefix = EXCLUDED.path_prefix,
            allow_owner_only = EXCLUDED.allow_owner_only`,
          [
            sp.id,
            p.id,
            sp.bucket_id,
            sp.name,
            sp.operation ?? "ALL",
            JSON.stringify(sp.roles ?? ["authenticated"]),
            sp.path_prefix ?? "",
            Boolean(sp.allow_owner_only),
            sp.created_at ?? new Date().toISOString(),
          ]
        );
      }

      for (const objSnap of snap.storageObjects ?? []) {
        const o = objSnap.row;
        await client.query(
          `INSERT INTO platform_storage_objects (
            id, project_id, bucket_id, path, size_bytes, mime_type, checksum_sha256, etag, storage_key, metadata, owner_id, version, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, now())
          ON CONFLICT (bucket_id, path) DO UPDATE SET
            size_bytes = EXCLUDED.size_bytes,
            mime_type = EXCLUDED.mime_type,
            checksum_sha256 = EXCLUDED.checksum_sha256,
            etag = EXCLUDED.etag,
            storage_key = EXCLUDED.storage_key,
            metadata = EXCLUDED.metadata,
            version = EXCLUDED.version,
            updated_at = now()`,
          [
            o.id,
            p.id,
            o.bucket_id,
            o.path,
            Number(o.size_bytes ?? 0),
            o.mime_type ?? "application/octet-stream",
            o.checksum_sha256,
            o.etag,
            o.storage_key,
            JSON.stringify(o.metadata ?? {}),
            o.owner_id ?? null,
            Number(o.version ?? 1),
            o.created_at ?? new Date().toISOString(),
          ]
        );
        if (objSnap.contentBase64) {
          const diskPath = resolve(
            config.STORAGE_DIR,
            String(o.storage_key)
          );
          await mkdir(dirname(diskPath), { recursive: true });
          await writeFile(
            diskPath,
            Buffer.from(objSnap.contentBase64, "base64")
          );
        }
        restoredStorageObjects += 1;
      }

      await ensureProjectSchemaPrivilegesAndTriggers(
        { ...p, db_role_name: dbRoleName },
        client
      );
    });

    const refreshedProject = await getProjectByRef(p.id);
    for (const pol of snap.rlsPolicies ?? []) {
      await createProjectRlsPolicy(refreshedProject, {
        tableName: pol.table_name,
        policyName: pol.policy_name,
        command: pol.command,
        usingExpression: pol.using_expression,
        checkExpression: pol.check_expression,
      });
    }
  }

  // 3. Restore platform project memberships if included
  if (bundle.platformState?.projectMembers) {
    await withTransaction(async (client) => {
      for (const m of bundle.platformState!.projectMembers) {
        await client.query(
          `INSERT INTO platform_project_members (id, project_id, user_id, role, permissions, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, now())
           ON CONFLICT (project_id, user_id) DO UPDATE SET
             role = EXCLUDED.role,
             permissions = EXCLUDED.permissions,
             updated_at = now()`,
          [
            m.id,
            m.project_id,
            m.user_id,
            m.role ?? "developer",
            JSON.stringify(m.permissions ?? []),
            m.created_at ?? new Date().toISOString(),
          ]
        );
      }
    });
  }

  const updatedRes = await pool.query(
    `UPDATE platform_backups SET status = 'restored', restored_at = now() WHERE id = $1 RETURNING *`,
    [backupId]
  );

  await recordAuditEvent({
    projectId: verification.backup.project_id,
    actorType: options.actorId ? "user" : "system",
    actorId: options.actorId ?? null,
    action: "backup.restored",
    resourceType: "backup",
    resourceId: backupId,
    metadata: {
      restoredProjects: bundle.projects.length,
      restoredTables,
      restoredRows,
      restoredFunctions,
      restoredAuthUsers,
      restoredStorageObjects,
    },
  });

  return {
    backup: normalizeBackupRow(updatedRes.rows[0]),
    restoredProjects: bundle.projects.length,
    restoredTables,
    restoredRows,
    restoredFunctions,
    restoredAuthUsers,
    restoredStorageObjects,
  };
}
