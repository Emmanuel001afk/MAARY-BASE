import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import {
  NotFoundError,
  ValidationError,
} from "../lib/errors.js";
import { quoteIdent } from "../lib/sql-safety.js";
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

interface ProjectBackupSnapshot {
  project: ProjectRecord;
  tables: Array<{
    schema: TableSchemaMetadata;
    rows: Record<string, unknown>[];
  }>;
  rlsPolicies: Array<{
    table_name: string;
    policy_name: string;
    command: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
    using_expression: string | null;
    check_expression: string | null;
  }>;
  functions: Array<Record<string, unknown>>;
  authUsers: Array<Record<string, unknown>>;
}

interface BackupBundle {
  formatVersion: "1.0";
  createdAt: string;
  backupType: "project" | "platform_full";
  projects: ProjectBackupSnapshot[];
}

function normalizeBackupRow(row: any): BackupRecord {
  return {
    ...row,
    size_bytes: Number(row.size_bytes),
  };
}

async function captureProjectSnapshot(
  project: ProjectRecord
): Promise<ProjectBackupSnapshot> {
  const tableSchemas = await inspectProjectSchema(project);
  const schemaIdent = quoteIdent(project.schema_name);

  const tables: ProjectBackupSnapshot["tables"] = [];
  for (const ts of tableSchemas) {
    const tblIdent = quoteIdent(ts.name);
    const rowsRes = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${schemaIdent}.${tblIdent}`
    );
    tables.push({
      schema: ts,
      rows: rowsRes.rows,
    });
  }

  const [polRes, fnRes, usersRes] = await Promise.all([
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
      `SELECT slug, name, description, code, entrypoint, version, status, verify_jwt, timeout_ms, env_vars
       FROM platform_functions WHERE project_id = $1`,
      [project.id]
    ),
    pool.query<Record<string, unknown>>(
      `SELECT id, email, phone, password_hash, email_verified, email_verified_at, role, status, user_metadata, app_metadata
       FROM project_auth_users WHERE project_id = $1`,
      [project.id]
    ),
  ]);

  return {
    project,
    tables,
    rlsPolicies: polRes.rows,
    functions: fnRes.rows,
    authUsers: usersRes.rows,
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

  const bundle: BackupBundle = {
    formatVersion: "1.0",
    createdAt: new Date().toISOString(),
    backupType,
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

  const res = await pool.query(
    `INSERT INTO platform_backups (
      project_id, backup_type, name, file_path, size_bytes, checksum_sha256, status, metadata, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7::jsonb, $8)
    RETURNING *`,
    [
      options.projectId ?? null,
      backupType,
      options.name?.trim() || `Backup ${slugLabel} (${new Date().toISOString()})`,
      filePath,
      dataBuf.byteLength,
      checksum,
      JSON.stringify({
        projectCount: snapshots.length,
        tableCount: totalTables,
        rowCount: totalRows,
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
  const res = await pool.query(
    `SELECT * FROM platform_backups WHERE id = $1`,
    [backupId]
  );
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
    throw new NotFoundError(`Backup file not found on disk at '${backup.file_path}'.`);
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

  for (const snap of bundle.projects) {
    const project = await getProjectByRef(snap.project.id);
    const schemaIdent = quoteIdent(project.schema_name);

    await withTransaction(async (client) => {
      for (const tbl of snap.tables) {
        const tblIdent = quoteIdent(tbl.schema.name);
        // Ensure table exists; if not, recreate it from column metadata
        const colDefs = tbl.schema.columns.map((c) => {
          const pk = c.isPrimaryKey ? " PRIMARY KEY" : "";
          const nn = !c.isNullable && !c.isPrimaryKey ? " NOT NULL" : "";
          return `${quoteIdent(c.name)} ${c.udtName === "int4" ? "integer" : c.udtName === "int8" ? "bigint" : c.dataType}${pk}${nn}`;
        });
        await client.query(
          `CREATE TABLE IF NOT EXISTS ${schemaIdent}.${tblIdent} (${colDefs.join(", ")})`
        );
        await client.query(`TRUNCATE TABLE ${schemaIdent}.${tblIdent} CASCADE`);
        restoredTables += 1;

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

        if (tbl.schema.rlsEnabled) {
          await client.query(
            `ALTER TABLE ${schemaIdent}.${tblIdent} ENABLE ROW LEVEL SECURITY`
          );
          if (tbl.schema.rlsForced) {
            await client.query(
              `ALTER TABLE ${schemaIdent}.${tblIdent} FORCE ROW LEVEL SECURITY`
            );
          }
        }
      }

      await ensureProjectSchemaPrivilegesAndTriggers(project, client);
    });

    for (const pol of snap.rlsPolicies) {
      await createProjectRlsPolicy(project, {
        tableName: pol.table_name,
        policyName: pol.policy_name,
        command: pol.command,
        usingExpression: pol.using_expression,
        checkExpression: pol.check_expression,
      });
    }
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
    },
  });

  return {
    backup: normalizeBackupRow(updatedRes.rows[0]),
    restoredProjects: bundle.projects.length,
    restoredTables,
    restoredRows,
  };
}
