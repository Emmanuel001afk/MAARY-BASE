import { createHash } from "node:crypto";
import { config } from "../config.js";
import {
  type DatabaseClient,
  pool,
  withRlsTransaction,
  withTransaction,
} from "../db/pool.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from "../lib/errors.js";
import {
  assertProjectSqlSafe,
  assertValidIdentifier,
  quoteIdent,
} from "../lib/sql-safety.js";
import { incrementProjectMetric, recordAuditEvent } from "./audit.service.js";
import type { ProjectRecord } from "./project.service.js";

export interface ColumnMetadata {
  name: string;
  dataType: string;
  udtName: string;
  isNullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  ordinalPosition: number;
}

export interface ForeignKeyMetadata {
  constraintName: string;
  columnName: string;
  foreignTableSchema: string;
  foreignTableName: string;
  foreignColumnName: string;
  onDelete: string;
  onUpdate: string;
}

export interface IndexMetadata {
  name: string;
  definition: string;
  isUnique: boolean;
}

export interface RlsPolicyMetadata {
  policyName: string;
  tableName: string;
  command: string;
  roles: string[];
  usingExpression: string | null;
  checkExpression: string | null;
}

export interface TableSchemaMetadata {
  name: string;
  schema: string;
  rlsEnabled: boolean;
  rlsForced: boolean;
  rowCount: number;
  columns: ColumnMetadata[];
  primaryKeys: string[];
  foreignKeys: ForeignKeyMetadata[];
  indexes: IndexMetadata[];
  policies: RlsPolicyMetadata[];
}

const ALLOWED_COLUMN_TYPES = new Set([
  "uuid",
  "text",
  "varchar",
  "char",
  "integer",
  "int",
  "int4",
  "bigint",
  "int8",
  "smallint",
  "serial",
  "bigserial",
  "boolean",
  "bool",
  "numeric",
  "decimal",
  "real",
  "double precision",
  "float8",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "json",
  "jsonb",
  "bytea",
  "inet",
  "cidr",
  "text[]",
  "integer[]",
  "uuid[]",
]);

function validateColumnType(rawType: string): string {
  const normalized = rawType.trim().toLowerCase();
  if (ALLOWED_COLUMN_TYPES.has(normalized)) {
    return normalized;
  }
  if (/^(varchar|character varying)\(\d{1,5}\)$/.test(normalized)) {
    return normalized;
  }
  if (/^(numeric|decimal)\(\d{1,3}(,\s*\d{1,3})?\)$/.test(normalized)) {
    return normalized;
  }
  throw new ValidationError(`Unsupported or unsafe SQL column type '${rawType}'.`);
}

export async function ensureProjectSchemaPrivilegesAndTriggers(
  project: ProjectRecord,
  client?: DatabaseClient
): Promise<void> {
  const runner = client ?? pool;
  const schemaIdent = quoteIdent(project.schema_name);
  const dbRoleName = project.db_role_name || "maary_rls_user";
  const rlsRoleName = project.db_role_name
    ? `${project.db_role_name}_rls`
    : "maary_rls_user";
  const roleIdent = quoteIdent(dbRoleName);
  const rlsRoleIdent = quoteIdent(rlsRoleName);

  // If running inside a role-restricted transaction, temporarily reset role for control-plane maintenance
  let previousRole: string | null = null;
  if (client) {
    const roleRes = await client.query<{
      current_user: string;
      session_user: string;
    }>("SELECT current_user, session_user");
    const cur = roleRes.rows[0]?.current_user;
    const sess = roleRes.rows[0]?.session_user;
    if (cur && sess && cur !== sess) {
      previousRole = cur;
      await client.query("RESET ROLE");
    }
  }

  try {
    await runner.query(`
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

    await runner.query(
      `REVOKE ALL ON SCHEMA ${schemaIdent} FROM PUBLIC, maary_rls_user, maary_anon, maary_authenticated, maary_service_role`
    );
    await runner.query(`GRANT ALL ON SCHEMA ${schemaIdent} TO ${roleIdent}`);
    await runner.query(
      `GRANT USAGE ON SCHEMA ${schemaIdent} TO ${rlsRoleIdent}`
    );
    await runner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaIdent} TO ${roleIdent}, ${rlsRoleIdent}`
    );
    await runner.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schemaIdent} TO ${roleIdent}, ${rlsRoleIdent}`
    );
    await runner.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schemaIdent} TO ${roleIdent}, ${rlsRoleIdent}`
    );

    const tablesRes = await runner.query<{ table_name: string }>(
      `SELECT t.table_name
       FROM information_schema.tables t
       WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'`,
      [project.schema_name]
    );

    for (const row of tablesRes.rows) {
      const tblIdent = quoteIdent(row.table_name);
      await runner.query(
        `ALTER TABLE ${schemaIdent}.${tblIdent} OWNER TO ${roleIdent}`
      );
      await runner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schemaIdent}.${tblIdent} TO ${roleIdent}, ${rlsRoleIdent}`
      );

      // Ensure service_role owner policy exists so role_<slug> can operate on RLS-forced tables in its own schema
      await runner.query(
        `DROP POLICY IF EXISTS "_marry_base_service_role_bypass" ON ${schemaIdent}.${tblIdent}`
      );
      await runner.query(
        `CREATE POLICY "_marry_base_service_role_bypass"
         ON ${schemaIdent}.${tblIdent}
         AS PERMISSIVE
         FOR ALL
         TO ${roleIdent}
         USING (true)
         WITH CHECK (true)`
      );

      const trigExists = await runner.query(
        `SELECT 1 FROM information_schema.triggers
         WHERE event_object_schema = $1
           AND event_object_table = $2
           AND trigger_name = 'maary_realtime_trigger'`,
        [project.schema_name, row.table_name]
      );
      if (!trigExists.rowCount) {
        await runner.query(
          `CREATE TRIGGER maary_realtime_trigger
           AFTER INSERT OR UPDATE OR DELETE ON ${schemaIdent}.${tblIdent}
           FOR EACH ROW EXECUTE FUNCTION public.maary_capture_row_change('${project.id}')`
        );
      }
    }

    const seqRes = await runner.query<{ sequence_name: string }>(
      `SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = $1`,
      [project.schema_name]
    );
    for (const seq of seqRes.rows) {
      const seqIdent = quoteIdent(seq.sequence_name);
      await runner.query(
        `ALTER SEQUENCE ${schemaIdent}.${seqIdent} OWNER TO ${roleIdent}`
      );
      await runner.query(
        `GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${schemaIdent}.${seqIdent} TO ${roleIdent}, ${rlsRoleIdent}`
      );
    }
  } finally {
    if (client && previousRole) {
      await client.query(`SET LOCAL ROLE ${quoteIdent(previousRole)}`);
    }
  }
}

export async function inspectProjectSchema(
  project: ProjectRecord
): Promise<TableSchemaMetadata[]> {
  const schema = project.schema_name;

  const tablesRes = await pool.query<{
    table_name: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT
       c.relname AS table_name,
       c.relrowsecurity,
       c.relforcerowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'
     ORDER BY c.relname ASC`,
    [schema]
  );

  if (tablesRes.rows.length === 0) {
    return [];
  }

  const [colsRes, pkRes, fkRes, idxRes, polRes] = await Promise.all([
    pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
      ordinal_position: number;
    }>(
      `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name ASC, ordinal_position ASC`,
      [schema]
    ),
    pool.query<{ table_name: string; column_name: string }>(
      `SELECT kcu.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_schema = $1`,
      [schema]
    ),
    pool.query<{
      table_name: string;
      constraint_name: string;
      column_name: string;
      foreign_table_schema: string;
      foreign_table_name: string;
      foreign_column_name: string;
      delete_rule: string;
      update_rule: string;
    }>(
      `SELECT
         tc.table_name,
         tc.constraint_name,
         kcu.column_name,
         ccu.table_schema AS foreign_table_schema,
         ccu.table_name AS foreign_table_name,
         ccu.column_name AS foreign_column_name,
         rc.delete_rule,
         rc.update_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.table_schema
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_schema = $1`,
      [schema]
    ),
    pool.query<{
      tablename: string;
      indexname: string;
      indexdef: string;
    }>(
      `SELECT tablename, indexname, indexdef
       FROM pg_indexes
       WHERE schemaname = $1`,
      [schema]
    ),
    pool.query<{
      tablename: string;
      policyname: string;
      cmd: string;
      roles: string[];
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename, policyname, cmd, roles, qual, with_check
       FROM pg_policies
       WHERE schemaname = $1
         AND policyname <> '_marry_base_service_role_bypass'`,
      [schema]
    ),
  ]);

  const pkByTable = new Map<string, Set<string>>();
  for (const pk of pkRes.rows) {
    if (!pkByTable.has(pk.table_name)) {
      pkByTable.set(pk.table_name, new Set());
    }
    pkByTable.get(pk.table_name)!.add(pk.column_name);
  }

  const results: TableSchemaMetadata[] = [];
  for (const t of tablesRes.rows) {
    const tablePks = pkByTable.get(t.table_name) ?? new Set<string>();
    const columns: ColumnMetadata[] = colsRes.rows
      .filter((c) => c.table_name === t.table_name)
      .map((c) => ({
        name: c.column_name,
        dataType: c.data_type,
        udtName: c.udt_name,
        isNullable: c.is_nullable === "YES",
        defaultValue: c.column_default,
        isPrimaryKey: tablePks.has(c.column_name),
        ordinalPosition: Number(c.ordinal_position),
      }));

    const foreignKeys: ForeignKeyMetadata[] = fkRes.rows
      .filter((f) => f.table_name === t.table_name)
      .map((f) => ({
        constraintName: f.constraint_name,
        columnName: f.column_name,
        foreignTableSchema: f.foreign_table_schema,
        foreignTableName: f.foreign_table_name,
        foreignColumnName: f.foreign_column_name,
        onDelete: f.delete_rule,
        onUpdate: f.update_rule,
      }));

    const indexes: IndexMetadata[] = idxRes.rows
      .filter((i) => i.tablename === t.table_name)
      .map((i) => ({
        name: i.indexname,
        definition: i.indexdef,
        isUnique: /CREATE UNIQUE INDEX/i.test(i.indexdef),
      }));

    const policies: RlsPolicyMetadata[] = polRes.rows
      .filter((p) => p.tablename === t.table_name)
      .map((p) => ({
        policyName: p.policyname,
        tableName: p.tablename,
        command: p.cmd,
        roles: Array.isArray(p.roles) ? p.roles : [String(p.roles)],
        usingExpression: p.qual,
        checkExpression: p.with_check,
      }));

    let rowCount = 0;
    try {
      const cnt = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${quoteIdent(schema)}.${quoteIdent(t.table_name)}`
      );
      rowCount = Number(cnt.rows[0]?.count ?? 0);
    } catch {
      rowCount = 0;
    }

    results.push({
      name: t.table_name,
      schema,
      rlsEnabled: Boolean(t.relrowsecurity),
      rlsForced: Boolean(t.relforcerowsecurity),
      rowCount,
      columns,
      primaryKeys: Array.from(tablePks),
      foreignKeys,
      indexes,
      policies,
    });
  }

  return results;
}

export async function getTableSchema(
  project: ProjectRecord,
  tableName: string
): Promise<TableSchemaMetadata> {
  assertValidIdentifier(tableName, "table");
  const all = await inspectProjectSchema(project);
  const found = all.find((t) => t.name === tableName);
  if (!found) {
    throw new NotFoundError(
      `Table '${tableName}' does not exist in project '${project.slug}'.`
    );
  }
  return found;
}

export interface CreateTableColumnInput {
  name: string;
  type: string;
  primaryKey?: boolean;
  notNull?: boolean;
  unique?: boolean;
  defaultValue?: string;
  references?: {
    table: string;
    column: string;
    onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
  };
}

export async function createProjectTable(
  project: ProjectRecord,
  input: {
    name: string;
    columns: CreateTableColumnInput[];
    enableRls?: boolean;
    actorId?: string | null;
  }
): Promise<TableSchemaMetadata> {
  assertValidIdentifier(input.name, "table");
  if (!input.columns || input.columns.length === 0) {
    throw new ValidationError("At least one column is required to create a table.");
  }

  const existingTables = await inspectProjectSchema(project);
  if (existingTables.some((t) => t.name === input.name)) {
    throw new ConflictError(`Table '${input.name}' already exists.`);
  }
  if (existingTables.length >= (project.quotas?.maxTables ?? 100)) {
    throw new QuotaExceededError(
      `Project table limit (${project.quotas.maxTables}) reached.`
    );
  }

  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(input.name);

  const colDefs: string[] = [];
  for (const col of input.columns) {
    assertValidIdentifier(col.name, "column");
    const colType = validateColumnType(col.type);
    const parts: string[] = [quoteIdent(col.name), colType];
    if (col.primaryKey) parts.push("PRIMARY KEY");
    if (col.notNull && !col.primaryKey) parts.push("NOT NULL");
    if (col.unique && !col.primaryKey) parts.push("UNIQUE");
    if (col.defaultValue !== undefined && col.defaultValue !== "") {
      // Allow safe default expressions (gen_random_uuid(), now(), true, false, numbers, quoted strings)
      const def = col.defaultValue.trim();
      if (
        /^(gen_random_uuid\(\)|now\(\)|current_timestamp|true|false|-?\d+(\.\d+)?|'[a-zA-Z0-9_ -]*'::[a-z0-9_]+|'[a-zA-Z0-9_ -]*'|\{\}'::jsonb|\[\]'::jsonb)$/i.test(
          def
        )
      ) {
        parts.push(`DEFAULT ${def}`);
      } else {
        throw new ValidationError(
          `Unsafe or unsupported column default expression '${def}'.`
        );
      }
    }
    if (col.references) {
      assertValidIdentifier(col.references.table, "referenced table");
      assertValidIdentifier(col.references.column, "referenced column");
      const onDelete = col.references.onDelete ?? "NO ACTION";
      if (!["CASCADE", "SET NULL", "RESTRICT", "NO ACTION"].includes(onDelete)) {
        throw new ValidationError(`Invalid ON DELETE rule '${onDelete}'.`);
      }
      parts.push(
        `REFERENCES ${schemaIdent}.${quoteIdent(col.references.table)}(${quoteIdent(col.references.column)}) ON DELETE ${onDelete}`
      );
    }
    colDefs.push(parts.join(" "));
  }

  await withTransaction(async (client) => {
    await client.query(
      `CREATE TABLE ${schemaIdent}.${tableIdent} (${colDefs.join(", ")})`
    );
    if (input.enableRls) {
      await client.query(
        `ALTER TABLE ${schemaIdent}.${tableIdent} ENABLE ROW LEVEL SECURITY`
      );
      await client.query(
        `ALTER TABLE ${schemaIdent}.${tableIdent} FORCE ROW LEVEL SECURITY`
      );
    }
    await ensureProjectSchemaPrivilegesAndTriggers(project, client);
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId ?? null,
    action: "database.table.created",
    resourceType: "table",
    resourceId: input.name,
    metadata: {
      columns: input.columns.map((c) => c.name),
      rlsEnabled: Boolean(input.enableRls),
    },
  });

  return getTableSchema(project, input.name);
}

export async function alterProjectTable(
  project: ProjectRecord,
  tableName: string,
  operation:
    | {
        action: "add_column";
        column: CreateTableColumnInput;
      }
    | {
        action: "drop_column";
        columnName: string;
      }
    | {
        action: "rename_column";
        fromName: string;
        toName: string;
      }
    | {
        action: "create_index";
        indexName: string;
        columns: string[];
        unique?: boolean;
      }
    | {
        action: "drop_index";
        indexName: string;
      },
  actorId?: string | null
): Promise<TableSchemaMetadata> {
  assertValidIdentifier(tableName, "table");
  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(tableName);

  // Verify table exists
  await getTableSchema(project, tableName);

  if (operation.action === "add_column") {
    const col = operation.column;
    assertValidIdentifier(col.name, "column");
    const colType = validateColumnType(col.type);
    const parts = [
      `ALTER TABLE ${schemaIdent}.${tableIdent} ADD COLUMN ${quoteIdent(col.name)} ${colType}`,
    ];
    if (col.notNull) parts.push("NOT NULL");
    if (col.unique) parts.push("UNIQUE");
    if (col.defaultValue) {
      parts.push(`DEFAULT ${col.defaultValue}`);
    }
    await pool.query(parts.join(" "));
  } else if (operation.action === "drop_column") {
    assertValidIdentifier(operation.columnName, "column");
    await pool.query(
      `ALTER TABLE ${schemaIdent}.${tableIdent} DROP COLUMN ${quoteIdent(operation.columnName)}`
    );
  } else if (operation.action === "rename_column") {
    assertValidIdentifier(operation.fromName, "column");
    assertValidIdentifier(operation.toName, "column");
    await pool.query(
      `ALTER TABLE ${schemaIdent}.${tableIdent} RENAME COLUMN ${quoteIdent(operation.fromName)} TO ${quoteIdent(operation.toName)}`
    );
  } else if (operation.action === "create_index") {
    assertValidIdentifier(operation.indexName, "index");
    if (!operation.columns.length) {
      throw new ValidationError("Index requires at least one column.");
    }
    const cols = operation.columns.map((c) => quoteIdent(c)).join(", ");
    const uniqueKeyword = operation.unique ? "UNIQUE " : "";
    await pool.query(
      `CREATE ${uniqueKeyword}INDEX ${quoteIdent(operation.indexName)} ON ${schemaIdent}.${tableIdent} (${cols})`
    );
  } else if (operation.action === "drop_index") {
    assertValidIdentifier(operation.indexName, "index");
    await pool.query(
      `DROP INDEX ${schemaIdent}.${quoteIdent(operation.indexName)}`
    );
  }

  await recordAuditEvent({
    projectId: project.id,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: `database.table.${operation.action}`,
    resourceType: "table",
    resourceId: tableName,
    metadata: operation as unknown as Record<string, unknown>,
  });

  return getTableSchema(project, tableName);
}

export async function dropProjectTable(
  project: ProjectRecord,
  tableName: string,
  confirmName?: string,
  actorId?: string | null
): Promise<void> {
  assertValidIdentifier(tableName, "table");
  if (confirmName !== undefined && confirmName !== tableName) {
    throw new ValidationError(
      `Confirmation table name '${confirmName}' does not match '${tableName}'.`
    );
  }
  await getTableSchema(project, tableName);

  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(tableName);

  await withTransaction(async (client) => {
    await client.query(`DROP TABLE ${schemaIdent}.${tableIdent} CASCADE`);
    await client.query(
      `DELETE FROM platform_rls_policies WHERE project_id = $1 AND table_name = $2`,
      [project.id, tableName]
    );
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "database.table.dropped",
    resourceType: "table",
    resourceId: tableName,
  });
}

// Row-Level Security (RLS)
export async function setProjectTableRls(
  project: ProjectRecord,
  tableName: string,
  enabled: boolean,
  force = true,
  actorId?: string | null
): Promise<TableSchemaMetadata> {
  await getTableSchema(project, tableName);
  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(tableName);

  await withTransaction(async (client) => {
    if (enabled) {
      await client.query(
        `ALTER TABLE ${schemaIdent}.${tableIdent} ENABLE ROW LEVEL SECURITY`
      );
      if (force) {
        await client.query(
          `ALTER TABLE ${schemaIdent}.${tableIdent} FORCE ROW LEVEL SECURITY`
        );
      } else {
        await client.query(
          `ALTER TABLE ${schemaIdent}.${tableIdent} NO FORCE ROW LEVEL SECURITY`
        );
      }
    } else {
      await client.query(
        `ALTER TABLE ${schemaIdent}.${tableIdent} DISABLE ROW LEVEL SECURITY`
      );
      await client.query(
        `ALTER TABLE ${schemaIdent}.${tableIdent} NO FORCE ROW LEVEL SECURITY`
      );
    }
    await ensureProjectSchemaPrivilegesAndTriggers(project, client);
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: enabled ? "database.rls.enabled" : "database.rls.disabled",
    resourceType: "table",
    resourceId: tableName,
    metadata: { enabled, force },
  });

  return getTableSchema(project, tableName);
}

export async function createProjectRlsPolicy(
  project: ProjectRecord,
  input: {
    tableName: string;
    policyName: string;
    command?: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
    usingExpression?: string | null;
    checkExpression?: string | null;
    enableRlsOnTable?: boolean;
    actorId?: string | null;
  }
): Promise<RlsPolicyMetadata> {
  assertValidIdentifier(input.tableName, "table");
  assertValidIdentifier(input.policyName, "policy");
  await getTableSchema(project, input.tableName);

  const cmd = input.command ?? "ALL";
  if (!["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"].includes(cmd)) {
    throw new ValidationError(`Invalid RLS policy command '${cmd}'.`);
  }

  const usingExpr = input.usingExpression?.trim() || null;
  const checkExpr = input.checkExpression?.trim() || null;

  if (!usingExpr && !checkExpr) {
    throw new ValidationError(
      "RLS policy requires at least a USING expression or a WITH CHECK expression."
    );
  }

  if (usingExpr) {
    assertProjectSqlSafe(`SELECT 1 WHERE ${usingExpr}`, {
      readOnly: true,
      targetSchema: project.schema_name,
    });
  }
  if (checkExpr) {
    assertProjectSqlSafe(`SELECT 1 WHERE ${checkExpr}`, {
      readOnly: true,
      targetSchema: project.schema_name,
    });
  }

  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(input.tableName);
  const policyIdent = quoteIdent(input.policyName);

  const clauses: string[] = [
    `CREATE POLICY ${policyIdent} ON ${schemaIdent}.${tableIdent}`,
    `AS PERMISSIVE FOR ${cmd}`,
    `TO PUBLIC`,
  ];
  if (usingExpr && cmd !== "INSERT") {
    clauses.push(`USING (${usingExpr})`);
  }
  if (checkExpr && (cmd === "ALL" || cmd === "INSERT" || cmd === "UPDATE")) {
    clauses.push(`WITH CHECK (${checkExpr})`);
  } else if (usingExpr && cmd === "INSERT" && !checkExpr) {
    clauses.push(`WITH CHECK (${usingExpr})`);
  }

  await withTransaction(async (client) => {
    if (input.enableRlsOnTable !== false) {
      await client.query(
        `ALTER TABLE ${schemaIdent}.${tableIdent} ENABLE ROW LEVEL SECURITY`
      );
      await client.query(
        `ALTER TABLE ${schemaIdent}.${tableIdent} FORCE ROW LEVEL SECURITY`
      );
    }
    await client.query(
      `DROP POLICY IF EXISTS ${policyIdent} ON ${schemaIdent}.${tableIdent}`
    );
    await client.query(clauses.join(" "));
    await ensureProjectSchemaPrivilegesAndTriggers(project, client);
    await client.query(
      `INSERT INTO platform_rls_policies (
        project_id, table_name, policy_name, command, roles, using_expression, check_expression
      ) VALUES ($1, $2, $3, $4, '["PUBLIC"]'::jsonb, $5, $6)
      ON CONFLICT (project_id, table_name, policy_name)
      DO UPDATE SET
        command = EXCLUDED.command,
        using_expression = EXCLUDED.using_expression,
        check_expression = EXCLUDED.check_expression`,
      [
        project.id,
        input.tableName,
        input.policyName,
        cmd,
        usingExpr,
        checkExpr,
      ]
    );
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId ?? null,
    action: "database.rls.policy_created",
    resourceType: "rls_policy",
    resourceId: `${input.tableName}.${input.policyName}`,
    metadata: {
      tableName: input.tableName,
      policyName: input.policyName,
      command: cmd,
      usingExpression: usingExpr,
      checkExpression: checkExpr,
    },
  });

  return {
    policyName: input.policyName,
    tableName: input.tableName,
    command: cmd,
    roles: ["PUBLIC"],
    usingExpression: usingExpr,
    checkExpression: checkExpr,
  };
}

export async function deleteProjectRlsPolicy(
  project: ProjectRecord,
  tableName: string,
  policyName: string,
  actorId?: string | null
): Promise<void> {
  assertValidIdentifier(tableName, "table");
  assertValidIdentifier(policyName, "policy");
  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(tableName);
  const policyIdent = quoteIdent(policyName);

  await withTransaction(async (client) => {
    await client.query(
      `DROP POLICY IF EXISTS ${policyIdent} ON ${schemaIdent}.${tableIdent}`
    );
    await client.query(
      `DELETE FROM platform_rls_policies WHERE project_id = $1 AND table_name = $2 AND policy_name = $3`,
      [project.id, tableName, policyName]
    );
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "database.rls.policy_deleted",
    resourceType: "rls_policy",
    resourceId: `${tableName}.${policyName}`,
  });
}

// SQL Execution
export async function executeProjectSql(
  project: ProjectRecord,
  input: {
    sql: string;
    params?: unknown[];
    readOnly?: boolean;
    allowDestructive?: boolean;
    rlsContext?: {
      role: "anon" | "authenticated" | "service_role";
      userId?: string | null;
      email?: string | null;
      claims?: Record<string, unknown>;
    };
    actorId?: string | null;
  }
): Promise<{
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: string[];
  durationMs: number;
}> {
  const analysis = assertProjectSqlSafe(input.sql, {
    readOnly: input.readOnly,
    allowDestructive: input.allowDestructive,
    targetSchema: project.schema_name,
  });

  const started = Date.now();
  const role = input.rlsContext?.role ?? "service_role";

  const res = await withRlsTransaction(
    {
      schemaName: project.schema_name,
      dbRoleName: project.db_role_name,
      role,
      userId: input.rlsContext?.userId ?? null,
      email: input.rlsContext?.email ?? null,
      projectId: project.id,
      claims: input.rlsContext?.claims,
      bypassRls: role === "service_role",
      statementTimeoutMs: config.STATEMENT_TIMEOUT_MS,
    },
    async (client) => {
      const qRes = await client.query(input.sql, input.params);
      const expectedRole = project.db_role_name
        ? role === "service_role"
          ? project.db_role_name
          : `${project.db_role_name}_rls`
        : "maary_rls_user";
      const roleCheck = await client.query<{ current_user: string }>(
        "SELECT current_user"
      );
      if (roleCheck.rows[0]?.current_user !== expectedRole) {
        throw new ForbiddenError(
          "Database privilege boundary violation: unauthorized role switch detected."
        );
      }
      if (!analysis.isReadOnly && role === "service_role") {
        await ensureProjectSchemaPrivilegesAndTriggers(project, client);
      }
      return qRes;
    }
  );

  const durationMs = Date.now() - started;
  const maxRows = project.quotas?.maxRowsPerQuery ?? config.MAX_QUERY_ROWS;
  const rows = (res.rows ?? []).slice(0, maxRows);
  const fields = (res.fields ?? []).map((f) => f.name);

  await incrementProjectMetric(project.id, "sql_queries_total", 1);

  if (!analysis.isReadOnly) {
    await recordAuditEvent({
      projectId: project.id,
      actorType: input.actorId ? "user" : "service",
      actorId: input.actorId ?? null,
      action: "database.sql.executed",
      resourceType: "database",
      resourceId: project.schema_name,
      metadata: {
        isDestructive: analysis.isDestructive,
        rowCount: res.rowCount ?? rows.length,
        durationMs,
      },
    });
  }

  return {
    rows,
    rowCount: res.rowCount ?? rows.length,
    fields,
    durationMs,
  };
}

// Project Migrations
export interface ProjectMigrationRecord {
  id: string;
  project_id: string;
  version: string;
  name: string;
  up_sql: string;
  down_sql: string;
  checksum: string;
  status: "applied" | "rolled_back" | "failed";
  applied_by: string | null;
  applied_at: string;
  rolled_back_at: string | null;
}

export async function listProjectMigrations(
  projectId: string
): Promise<ProjectMigrationRecord[]> {
  const res = await pool.query<ProjectMigrationRecord>(
    `SELECT * FROM platform_project_migrations WHERE project_id = $1 ORDER BY version ASC`,
    [projectId]
  );
  return res.rows;
}

export async function applyProjectMigration(
  project: ProjectRecord,
  input: {
    version: string;
    name: string;
    upSql: string;
    downSql?: string;
    allowDestructive?: boolean;
    actorId?: string | null;
  }
): Promise<ProjectMigrationRecord> {
  const version = input.version.trim();
  const name = input.name.trim();
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(version)) {
    throw new ValidationError("Migration version must be 1-64 alphanumeric characters.");
  }
  if (!name) {
    throw new ValidationError("Migration name is required.");
  }

  assertProjectSqlSafe(input.upSql, {
    readOnly: false,
    allowDestructive: input.allowDestructive ?? true,
    targetSchema: project.schema_name,
  });

  const checksum = createHash("sha256").update(input.upSql).digest("hex");

  const existing = await pool.query<ProjectMigrationRecord>(
    `SELECT * FROM platform_project_migrations WHERE project_id = $1 AND version = $2`,
    [project.id, version]
  );
  if (existing.rows[0] && existing.rows[0].status === "applied") {
    if (existing.rows[0].checksum !== checksum) {
      throw new ConflictError(
        `Migration version '${version}' was already applied with a different checksum.`
      );
    }
    return existing.rows[0];
  }

  const schemaIdent = quoteIdent(project.schema_name);
  const roleIdent = project.db_role_name
    ? quoteIdent(project.db_role_name)
    : "maary_rls_user";
  const record = await withTransaction(async (client) => {
    await client.query(`SET LOCAL search_path TO ${schemaIdent}, auth, public`);
    await client.query(`SET LOCAL ROLE ${roleIdent}`);
    await client.query(input.upSql);
    await client.query("RESET ROLE");
    await ensureProjectSchemaPrivilegesAndTriggers(project, client);

    const migRes = await client.query<ProjectMigrationRecord>(
      `INSERT INTO platform_project_migrations (
        project_id, version, name, up_sql, down_sql, checksum, status, applied_by, applied_at, rolled_back_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'applied', $7, now(), NULL)
      ON CONFLICT (project_id, version)
      DO UPDATE SET
        name = EXCLUDED.name,
        up_sql = EXCLUDED.up_sql,
        down_sql = EXCLUDED.down_sql,
        checksum = EXCLUDED.checksum,
        status = 'applied',
        applied_by = EXCLUDED.applied_by,
        applied_at = now(),
        rolled_back_at = NULL
      RETURNING *`,
      [
        project.id,
        version,
        name,
        input.upSql,
        input.downSql ?? "",
        checksum,
        input.actorId ?? null,
      ]
    );
    return migRes.rows[0]!;
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId ?? null,
    action: "database.migration.applied",
    resourceType: "migration",
    resourceId: `${version}_${name}`,
    metadata: { version, name, checksum },
  });

  return record;
}

export async function rollbackProjectMigration(
  project: ProjectRecord,
  version: string,
  actorId?: string | null
): Promise<ProjectMigrationRecord> {
  const existingRes = await pool.query<ProjectMigrationRecord>(
    `SELECT * FROM platform_project_migrations WHERE project_id = $1 AND version = $2`,
    [project.id, version]
  );
  const migration = existingRes.rows[0];
  if (!migration) {
    throw new NotFoundError(`Migration version '${version}' not found.`);
  }
  if (migration.status !== "applied") {
    throw new ValidationError(`Migration '${version}' is not currently applied.`);
  }
  if (!migration.down_sql || !migration.down_sql.trim()) {
    throw new ValidationError(
      `Migration '${version}' does not define a rollback (downSql) script.`
    );
  }

  assertProjectSqlSafe(migration.down_sql, {
    readOnly: false,
    allowDestructive: true,
    targetSchema: project.schema_name,
  });

  const schemaIdent = quoteIdent(project.schema_name);
  const roleIdent = project.db_role_name
    ? quoteIdent(project.db_role_name)
    : "maary_rls_user";
  const updated = await withTransaction(async (client) => {
    await client.query(`SET LOCAL search_path TO ${schemaIdent}, auth, public`);
    await client.query(`SET LOCAL ROLE ${roleIdent}`);
    await client.query(migration.down_sql);
    await client.query("RESET ROLE");
    const res = await client.query<ProjectMigrationRecord>(
      `UPDATE platform_project_migrations
       SET status = 'rolled_back', rolled_back_at = now()
       WHERE id = $1
       RETURNING *`,
      [migration.id]
    );
    return res.rows[0]!;
  });

  await recordAuditEvent({
    projectId: project.id,
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "database.migration.rolled_back",
    resourceType: "migration",
    resourceId: `${migration.version}_${migration.name}`,
  });

  return updated;
}

// Extensions Management
const SUPPORTED_EXTENSIONS = new Set([
  "pgcrypto",
  "uuid-ossp",
  "pg_trgm",
  "hstore",
  "ltree",
  "citext",
  "plpgsql",
]);

export async function listDatabaseExtensions(): Promise<
  Array<{
    name: string;
    installedVersion: string | null;
    defaultVersion: string | null;
    comment: string | null;
    supported: boolean;
  }>
> {
  const res = await pool.query<{
    name: string;
    default_version: string | null;
    installed_version: string | null;
    comment: string | null;
  }>(
    `SELECT name, default_version, installed_version, comment
     FROM pg_available_extensions
     WHERE name = ANY($1::text[]) OR installed_version IS NOT NULL
     ORDER BY name ASC`,
    [Array.from(SUPPORTED_EXTENSIONS)]
  );
  return res.rows.map((r) => ({
    name: r.name,
    installedVersion: r.installed_version,
    defaultVersion: r.default_version,
    comment: r.comment,
    supported: SUPPORTED_EXTENSIONS.has(r.name),
  }));
}

export async function enableDatabaseExtension(
  extensionName: string,
  actorId?: string | null
): Promise<{ name: string; installed: boolean }> {
  const normalized = extensionName.trim().toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(normalized)) {
    throw new ValidationError(
      `Extension '${extensionName}' is not in the supported extension allowlist (${Array.from(SUPPORTED_EXTENSIONS).join(", ")}).`
    );
  }
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "${normalized}"`);
  await recordAuditEvent({
    actorType: actorId ? "user" : "system",
    actorId: actorId ?? null,
    action: "database.extension.enabled",
    resourceType: "extension",
    resourceId: normalized,
  });
  return { name: normalized, installed: true };
}
