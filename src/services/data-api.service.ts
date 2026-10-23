import { config } from "../config.js";
import { withRlsTransaction } from "../db/pool.js";
import {
  NotFoundError,
  ValidationError,
} from "../lib/errors.js";
import { assertValidIdentifier, quoteIdent } from "../lib/sql-safety.js";
import { incrementProjectMetric } from "./audit.service.js";
import {
  inspectProjectSchema,
  type TableSchemaMetadata,
} from "./database.service.js";
import type { ProjectRecord } from "./project.service.js";

export type FilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "in"
  | "is"
  | "contains";

export interface DataFilter {
  column: string;
  operator: FilterOperator;
  value: unknown;
}

export interface DataOrder {
  column: string;
  direction: "ASC" | "DESC";
  nulls?: "FIRST" | "LAST";
}

export interface DataAuthContext {
  role: "anon" | "authenticated" | "service_role";
  userId?: string | null;
  email?: string | null;
  claims?: Record<string, unknown>;
}

function splitTopLevelCommas(input: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of input) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function buildSelectClause(
  selectStr: string | undefined,
  currentTable: TableSchemaMetadata,
  allTables: TableSchemaMetadata[]
): string {
  const schemaIdent = quoteIdent(currentTable.schema);
  const tableIdent = quoteIdent(currentTable.name);

  if (!selectStr || selectStr.trim() === "" || selectStr.trim() === "*") {
    return `${tableIdent}.*`;
  }

  const tokens = splitTopLevelCommas(selectStr);
  const selectExpressions: string[] = [];
  const validCols = new Set(currentTable.columns.map((c) => c.name));

  for (const token of tokens) {
    if (token === "*") {
      selectExpressions.push(`${tableIdent}.*`);
      continue;
    }

    // Check for relationship embedding: e.g. author:users(id,name) or comments(id,body)
    const relMatch = token.match(
      /^(?:([a-zA-Z_][a-zA-Z0-9_]*):)?([a-zA-Z_][a-zA-Z0-9_]*)\((.+)\)$/
    );
    if (relMatch) {
      const alias = relMatch[1] || relMatch[2]!;
      const targetTableName = relMatch[2]!;
      const innerColsRaw = relMatch[3]!.trim();

      assertValidIdentifier(alias, "relationship alias");
      assertValidIdentifier(targetTableName, "related table");

      const targetTable = allTables.find((t) => t.name === targetTableName);
      if (!targetTable) {
        throw new ValidationError(
          `Related table '${targetTableName}' does not exist in project schema.`
        );
      }

      const targetValidCols = new Set(targetTable.columns.map((c) => c.name));
      let innerProjection = "*";
      if (innerColsRaw !== "*") {
        const innerColNames = innerColsRaw
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        for (const ic of innerColNames) {
          if (!targetValidCols.has(ic)) {
            throw new ValidationError(
              `Column '${ic}' does not exist on related table '${targetTableName}'.`
            );
          }
        }
        innerProjection = innerColNames.map((ic) => quoteIdent(ic)).join(", ");
      }

      const targetIdent = quoteIdent(targetTable.name);

      // 1. Check many-to-one (currentTable has FK to targetTable)
      const belongsToFk = currentTable.foreignKeys.find(
        (fk) => fk.foreignTableName === targetTable.name
      );
      if (belongsToFk) {
        selectExpressions.push(
          `(SELECT to_jsonb(_rel) FROM (SELECT ${innerProjection} FROM ${schemaIdent}.${targetIdent} WHERE ${targetIdent}.${quoteIdent(belongsToFk.foreignColumnName)} = ${tableIdent}.${quoteIdent(belongsToFk.columnName)} LIMIT 1) _rel) AS ${quoteIdent(alias)}`
        );
        continue;
      }

      // 2. Check one-to-many (targetTable has FK to currentTable)
      const hasManyFk = targetTable.foreignKeys.find(
        (fk) => fk.foreignTableName === currentTable.name
      );
      if (hasManyFk) {
        selectExpressions.push(
          `COALESCE((SELECT jsonb_agg(to_jsonb(_rel)) FROM (SELECT ${innerProjection} FROM ${schemaIdent}.${targetIdent} WHERE ${targetIdent}.${quoteIdent(hasManyFk.columnName)} = ${tableIdent}.${quoteIdent(hasManyFk.foreignColumnName)}) _rel), '[]'::jsonb) AS ${quoteIdent(alias)}`
        );
        continue;
      }

      throw new ValidationError(
        `No foreign key relationship found between '${currentTable.name}' and '${targetTable.name}'.`
      );
    }

    // Standard column projection (with optional alias: alias:column_name)
    const colAliasMatch = token.match(
      /^(?:([a-zA-Z_][a-zA-Z0-9_]*):)?([a-zA-Z_][a-zA-Z0-9_]*)$/
    );
    if (!colAliasMatch) {
      throw new ValidationError(`Invalid select token '${token}'.`);
    }
    const colAlias = colAliasMatch[1];
    const colName = colAliasMatch[2]!;
    if (!validCols.has(colName)) {
      throw new ValidationError(
        `Column '${colName}' does not exist on table '${currentTable.name}'.`
      );
    }
    if (colAlias) {
      assertValidIdentifier(colAlias, "column alias");
      selectExpressions.push(
        `${tableIdent}.${quoteIdent(colName)} AS ${quoteIdent(colAlias)}`
      );
    } else {
      selectExpressions.push(`${tableIdent}.${quoteIdent(colName)}`);
    }
  }

  return selectExpressions.join(", ");
}

function buildWhereClause(
  table: TableSchemaMetadata,
  filters: DataFilter[],
  orExpression?: string,
  startingParamIndex = 1
): { whereSql: string; params: unknown[] } {
  const validCols = new Set(table.columns.map((c) => c.name));
  const tableIdent = quoteIdent(table.name);
  const clauses: string[] = [];
  const params: unknown[] = [];

  const addFilterCondition = (filter: DataFilter): string => {
    if (!validCols.has(filter.column)) {
      throw new ValidationError(
        `Cannot filter on unknown column '${filter.column}' in table '${table.name}'.`
      );
    }
    const colRef = `${tableIdent}.${quoteIdent(filter.column)}`;
    const op = filter.operator;

    switch (op) {
      case "eq":
        params.push(filter.value);
        return `${colRef} = $${startingParamIndex + params.length - 1}`;
      case "neq":
        params.push(filter.value);
        return `${colRef} != $${startingParamIndex + params.length - 1}`;
      case "gt":
        params.push(filter.value);
        return `${colRef} > $${startingParamIndex + params.length - 1}`;
      case "gte":
        params.push(filter.value);
        return `${colRef} >= $${startingParamIndex + params.length - 1}`;
      case "lt":
        params.push(filter.value);
        return `${colRef} < $${startingParamIndex + params.length - 1}`;
      case "lte":
        params.push(filter.value);
        return `${colRef} <= $${startingParamIndex + params.length - 1}`;
      case "like": {
        const pattern = String(filter.value).replace(/\*/g, "%");
        params.push(pattern);
        return `${colRef}::text LIKE $${startingParamIndex + params.length - 1}`;
      }
      case "ilike": {
        const pattern = String(filter.value).replace(/\*/g, "%");
        params.push(pattern);
        return `${colRef}::text ILIKE $${startingParamIndex + params.length - 1}`;
      }
      case "in": {
        const list = Array.isArray(filter.value)
          ? filter.value
          : String(filter.value)
              .replace(/^\(|\)$/g, "")
              .split(",")
              .map((v) => v.trim().replace(/^["']|["']$/g, ""))
              .filter((v) => v.length > 0);
        if (list.length === 0) {
          return "FALSE";
        }
        const placeholders = list.map((item) => {
          params.push(item);
          return `$${startingParamIndex + params.length - 1}`;
        });
        return `${colRef} IN (${placeholders.join(", ")})`;
      }
      case "is": {
        const val = String(filter.value).toLowerCase();
        if (val === "null") return `${colRef} IS NULL`;
        if (val === "not.null" || val === "notnull")
          return `${colRef} IS NOT NULL`;
        if (val === "true") return `${colRef} IS TRUE`;
        if (val === "false") return `${colRef} IS FALSE`;
        throw new ValidationError(
          `Invalid 'is' filter value '${String(filter.value)}'. Expected null, not.null, true, or false.`
        );
      }
      case "contains": {
        const jsonVal =
          typeof filter.value === "string"
            ? filter.value
            : JSON.stringify(filter.value);
        params.push(jsonVal);
        return `${colRef}::jsonb @> $${startingParamIndex + params.length - 1}::jsonb`;
      }
      default:
        throw new ValidationError(`Unsupported filter operator '${String(op)}'.`);
    }
  };

  for (const f of filters) {
    clauses.push(addFilterCondition(f));
  }

  if (orExpression) {
    // Parse PostgREST style or=(col.op.val,col2.op.val2)
    const inner = orExpression.trim().replace(/^\(|\)$/g, "");
    const parts = splitTopLevelCommas(inner);
    const orSubClauses: string[] = [];
    for (const part of parts) {
      const m = part.match(
        /^([a-zA-Z_][a-zA-Z0-9_]*)\.(eq|neq|gt|gte|lt|lte|like|ilike|is|in)\.(.+)$/
      );
      if (!m) {
        throw new ValidationError(`Invalid OR filter expression '${part}'.`);
      }
      orSubClauses.push(
        addFilterCondition({
          column: m[1]!,
          operator: m[2] as FilterOperator,
          value: m[3],
        })
      );
    }
    if (orSubClauses.length > 0) {
      clauses.push(`(${orSubClauses.join(" OR ")})`);
    }
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

export function parseQueryParamsToFilters(
  query: Record<string, unknown>
): {
  select?: string;
  filters: DataFilter[];
  orExpression?: string;
  orders: DataOrder[];
  limit?: number;
  offset?: number;
  single?: boolean;
  count?: boolean;
  onConflict?: string;
} {
  const reserved = new Set([
    "select",
    "order",
    "limit",
    "offset",
    "single",
    "count",
    "or",
    "filter",
    "on_conflict",
    "onConflict",
  ]);

  const filters: DataFilter[] = [];

  if (typeof query.filter === "string" && query.filter.trim()) {
    try {
      const parsedFilter = JSON.parse(query.filter) as Record<
        string,
        Record<string, unknown> | unknown
      >;
      for (const [col, cond] of Object.entries(parsedFilter)) {
        if (
          cond &&
          typeof cond === "object" &&
          !Array.isArray(cond)
        ) {
          for (const [op, val] of Object.entries(
            cond as Record<string, unknown>
          )) {
            filters.push({
              column: col,
              operator: op as FilterOperator,
              value: val,
            });
          }
        } else {
          filters.push({ column: col, operator: "eq", value: cond });
        }
      }
    } catch {
      throw new ValidationError("Invalid JSON in 'filter' query parameter.");
    }
  }

  for (const [key, rawVal] of Object.entries(query)) {
    if (reserved.has(key) || rawVal === undefined) continue;
    const values = Array.isArray(rawVal) ? rawVal : [rawVal];
    for (const v of values) {
      const strVal = String(v);
      const opMatch = strVal.match(
        /^(eq|neq|gt|gte|lt|lte|like|ilike|in|is|contains)\.([\s\S]*)$/
      );
      if (opMatch) {
        filters.push({
          column: key,
          operator: opMatch[1] as FilterOperator,
          value: opMatch[2],
        });
      } else {
        filters.push({
          column: key,
          operator: "eq",
          value: strVal,
        });
      }
    }
  }

  const orders: DataOrder[] = [];
  if (typeof query.order === "string" && query.order.trim()) {
    const parts = query.order.split(",").map((s) => s.trim()).filter(Boolean);
    for (const part of parts) {
      const [col, dirRaw, nullsRaw] = part.split(/[.:]/);
      if (!col) continue;
      assertValidIdentifier(col, "order column");
      const dir =
        dirRaw && dirRaw.toUpperCase() === "DESC" ? "DESC" : "ASC";
      const nulls =
        nullsRaw?.toLowerCase() === "nullsfirst"
          ? "FIRST"
          : nullsRaw?.toLowerCase() === "nullslast"
            ? "LAST"
            : undefined;
      orders.push({ column: col, direction: dir, nulls });
    }
  }

  const limit =
    query.limit !== undefined ? Number(query.limit) : undefined;
  const offset =
    query.offset !== undefined ? Number(query.offset) : undefined;

  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new ValidationError("Parameter 'limit' must be a positive integer.");
  }
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new ValidationError(
      "Parameter 'offset' must be a non-negative integer."
    );
  }

  return {
    select: typeof query.select === "string" ? query.select : undefined,
    filters,
    orExpression: typeof query.or === "string" ? query.or : undefined,
    orders,
    limit,
    offset,
    single: query.single === "true" || query.single === true,
    count:
      query.count === "exact" ||
      query.count === "true" ||
      query.count === true,
    onConflict:
      typeof query.on_conflict === "string"
        ? query.on_conflict
        : typeof query.onConflict === "string"
          ? query.onConflict
          : undefined,
  };
}

export async function queryTableRows(
  project: ProjectRecord,
  tableName: string,
  options: {
    select?: string;
    filters?: DataFilter[];
    orExpression?: string;
    orders?: DataOrder[];
    limit?: number;
    offset?: number;
    single?: boolean;
    count?: boolean;
  },
  auth: DataAuthContext
): Promise<{
  data: Record<string, unknown>[] | Record<string, unknown> | null;
  count?: number;
}> {
  assertValidIdentifier(tableName, "table");
  const allTables = await inspectProjectSchema(project);
  const table = allTables.find((t) => t.name === tableName);
  if (!table) {
    throw new NotFoundError(
      `Table '${tableName}' does not exist in project '${project.slug}'.`
    );
  }

  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(table.name);
  const selectClause = buildSelectClause(options.select, table, allTables);
  const { whereSql, params } = buildWhereClause(
    table,
    options.filters ?? [],
    options.orExpression,
    1
  );

  const validCols = new Set(table.columns.map((c) => c.name));
  const orderParts: string[] = [];
  for (const ord of options.orders ?? []) {
    if (!validCols.has(ord.column)) {
      throw new ValidationError(
        `Cannot order by unknown column '${ord.column}' on table '${table.name}'.`
      );
    }
    const nullsClause = ord.nulls ? ` NULLS ${ord.nulls}` : "";
    orderParts.push(
      `${tableIdent}.${quoteIdent(ord.column)} ${ord.direction}${nullsClause}`
    );
  }
  const orderSql =
    orderParts.length > 0 ? `ORDER BY ${orderParts.join(", ")}` : "";

  const maxLimit = project.quotas?.maxRowsPerQuery ?? config.MAX_QUERY_ROWS;
  const limit = Math.min(options.limit ?? 100, maxLimit);
  const offset = options.offset ?? 0;

  const result = await withRlsTransaction(
    {
      schemaName: project.schema_name,
      dbRoleName: project.db_role_name,
      role: auth.role,
      userId: auth.userId ?? null,
      email: auth.email ?? null,
      projectId: project.id,
      claims: auth.claims,
      bypassRls: auth.role === "service_role",
    },
    async (client) => {
      let totalCount: number | undefined;
      if (options.count) {
        const countRes = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM ${schemaIdent}.${tableIdent} ${whereSql}`,
          params
        );
        totalCount = Number(countRes.rows[0]?.count ?? 0);
      }

      const queryParams = [...params, limit, offset];
      const sql = `SELECT ${selectClause} FROM ${schemaIdent}.${tableIdent} ${whereSql} ${orderSql} LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`;
      const rowsRes = await client.query<Record<string, unknown>>(
        sql,
        queryParams
      );
      return { rows: rowsRes.rows, totalCount };
    }
  );

  await incrementProjectMetric(project.id, "rest_read_requests", 1);

  if (options.single) {
    if (result.rows.length === 0) {
      throw new NotFoundError(`Requested row in '${tableName}' was not found.`);
    }
    return {
      data: result.rows[0]!,
      ...(result.totalCount !== undefined ? { count: result.totalCount } : {}),
    };
  }

  return {
    data: result.rows,
    ...(result.totalCount !== undefined ? { count: result.totalCount } : {}),
  };
}

export async function insertTableRows(
  project: ProjectRecord,
  tableName: string,
  payload: Record<string, unknown> | Array<Record<string, unknown>>,
  options: {
    onConflict?: string;
    ignoreDuplicates?: boolean;
    select?: string;
  },
  auth: DataAuthContext
): Promise<Record<string, unknown>[]> {
  assertValidIdentifier(tableName, "table");
  const allTables = await inspectProjectSchema(project);
  const table = allTables.find((t) => t.name === tableName);
  if (!table) {
    throw new NotFoundError(
      `Table '${tableName}' does not exist in project '${project.slug}'.`
    );
  }

  const rowsInput = Array.isArray(payload) ? payload : [payload];
  if (rowsInput.length === 0) {
    throw new ValidationError("Insert payload cannot be empty.");
  }

  const colMap = new Map(table.columns.map((c) => [c.name, c]));
  const columnsSet = new Set<string>();
  for (const row of rowsInput) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new ValidationError("Each insert item must be a JSON object.");
    }
    for (const key of Object.keys(row)) {
      if (!colMap.has(key)) {
        throw new ValidationError(
          `Column '${key}' does not exist on table '${table.name}'.`
        );
      }
      columnsSet.add(key);
    }
  }

  const columns = Array.from(columnsSet);
  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(table.name);
  const returningClause = buildSelectClause(options.select, table, allTables);

  let sql: string;
  const params: unknown[] = [];

  if (columns.length === 0) {
    sql = `INSERT INTO ${schemaIdent}.${tableIdent} DEFAULT VALUES RETURNING ${returningClause}`;
  } else {
    const colIdents = columns.map((c) => quoteIdent(c)).join(", ");
    const valueTuples: string[] = [];
    for (const row of rowsInput) {
      const tuplePlaceholders: string[] = [];
      for (const col of columns) {
        const val = row[col];
        if (val === undefined) {
          tuplePlaceholders.push("DEFAULT");
        } else {
          const colInfo = colMap.get(col);
          if (
            val !== null &&
            typeof val === "object" &&
            (colInfo?.udtName === "jsonb" || colInfo?.udtName === "json")
          ) {
            params.push(JSON.stringify(val));
          } else {
            params.push(val);
          }
          tuplePlaceholders.push(`$${params.length}`);
        }
      }
      valueTuples.push(`(${tuplePlaceholders.join(", ")})`);
    }

    let conflictClause = "";
    if (options.onConflict) {
      const conflictCols = options.onConflict
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      for (const cc of conflictCols) {
        if (!colMap.has(cc)) {
          throw new ValidationError(
            `onConflict column '${cc}' does not exist on table '${table.name}'.`
          );
        }
      }
      const conflictIdentList = conflictCols
        .map((c) => quoteIdent(c))
        .join(", ");
      if (options.ignoreDuplicates) {
        conflictClause = ` ON CONFLICT (${conflictIdentList}) DO NOTHING`;
      } else {
        const updateAssignments = columns
          .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
          .join(", ");
        conflictClause = ` ON CONFLICT (${conflictIdentList}) DO UPDATE SET ${updateAssignments}`;
      }
    }

    sql = `INSERT INTO ${schemaIdent}.${tableIdent} (${colIdents}) VALUES ${valueTuples.join(", ")}${conflictClause} RETURNING ${returningClause}`;
  }

  const inserted = await withRlsTransaction(
    {
      schemaName: project.schema_name,
      dbRoleName: project.db_role_name,
      role: auth.role,
      userId: auth.userId ?? null,
      email: auth.email ?? null,
      projectId: project.id,
      claims: auth.claims,
      bypassRls: auth.role === "service_role",
    },
    async (client) => {
      const res = await client.query<Record<string, unknown>>(sql, params);
      return res.rows;
    }
  );

  await incrementProjectMetric(project.id, "rest_write_requests", 1);
  return inserted;
}

export async function updateTableRows(
  project: ProjectRecord,
  tableName: string,
  values: Record<string, unknown>,
  options: {
    filters: DataFilter[];
    orExpression?: string;
    select?: string;
    allowUnfiltered?: boolean;
  },
  auth: DataAuthContext
): Promise<Record<string, unknown>[]> {
  assertValidIdentifier(tableName, "table");
  const allTables = await inspectProjectSchema(project);
  const table = allTables.find((t) => t.name === tableName);
  if (!table) {
    throw new NotFoundError(
      `Table '${tableName}' does not exist in project '${project.slug}'.`
    );
  }

  if (
    !options.allowUnfiltered &&
    options.filters.length === 0 &&
    !options.orExpression
  ) {
    throw new ValidationError(
      "Filtered WHERE conditions are required for UPDATE operations."
    );
  }

  const colMap = new Map(table.columns.map((c) => [c.name, c]));
  const keys = Object.keys(values).filter((k) => values[k] !== undefined);
  if (keys.length === 0) {
    throw new ValidationError("Update payload must specify at least one column.");
  }

  const setParts: string[] = [];
  const setParams: unknown[] = [];

  for (const key of keys) {
    const colInfo = colMap.get(key);
    if (!colInfo) {
      throw new ValidationError(
        `Column '${key}' does not exist on table '${table.name}'.`
      );
    }
    const val = values[key];
    if (
      val !== null &&
      typeof val === "object" &&
      (colInfo.udtName === "jsonb" || colInfo.udtName === "json")
    ) {
      setParams.push(JSON.stringify(val));
    } else {
      setParams.push(val);
    }
    setParts.push(`${quoteIdent(key)} = $${setParams.length}`);
  }

  const { whereSql, params: whereParams } = buildWhereClause(
    table,
    options.filters,
    options.orExpression,
    setParams.length + 1
  );

  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(table.name);
  const returningClause = buildSelectClause(options.select, table, allTables);
  const sql = `UPDATE ${schemaIdent}.${tableIdent} SET ${setParts.join(", ")} ${whereSql} RETURNING ${returningClause}`;

  const updated = await withRlsTransaction(
    {
      schemaName: project.schema_name,
      dbRoleName: project.db_role_name,
      role: auth.role,
      userId: auth.userId ?? null,
      email: auth.email ?? null,
      projectId: project.id,
      claims: auth.claims,
      bypassRls: auth.role === "service_role",
    },
    async (client) => {
      const res = await client.query<Record<string, unknown>>(sql, [
        ...setParams,
        ...whereParams,
      ]);
      return res.rows;
    }
  );

  await incrementProjectMetric(project.id, "rest_write_requests", 1);
  return updated;
}

export async function deleteTableRows(
  project: ProjectRecord,
  tableName: string,
  options: {
    filters: DataFilter[];
    orExpression?: string;
    select?: string;
    allowUnfiltered?: boolean;
  },
  auth: DataAuthContext
): Promise<Record<string, unknown>[]> {
  assertValidIdentifier(tableName, "table");
  const allTables = await inspectProjectSchema(project);
  const table = allTables.find((t) => t.name === tableName);
  if (!table) {
    throw new NotFoundError(
      `Table '${tableName}' does not exist in project '${project.slug}'.`
    );
  }

  if (
    !options.allowUnfiltered &&
    options.filters.length === 0 &&
    !options.orExpression
  ) {
    throw new ValidationError(
      "Filtered WHERE conditions are required for DELETE operations."
    );
  }

  const { whereSql, params } = buildWhereClause(
    table,
    options.filters,
    options.orExpression,
    1
  );
  const schemaIdent = quoteIdent(project.schema_name);
  const tableIdent = quoteIdent(table.name);
  const returningClause = buildSelectClause(options.select, table, allTables);
  const sql = `DELETE FROM ${schemaIdent}.${tableIdent} ${whereSql} RETURNING ${returningClause}`;

  const deleted = await withRlsTransaction(
    {
      schemaName: project.schema_name,
      dbRoleName: project.db_role_name,
      role: auth.role,
      userId: auth.userId ?? null,
      email: auth.email ?? null,
      projectId: project.id,
      claims: auth.claims,
      bypassRls: auth.role === "service_role",
    },
    async (client) => {
      const res = await client.query<Record<string, unknown>>(sql, params);
      return res.rows;
    }
  );

  await incrementProjectMetric(project.id, "rest_write_requests", 1);
  return deleted;
}

export async function invokeProjectRpc(
  project: ProjectRecord,
  functionName: string,
  args: Record<string, unknown> | unknown[],
  auth: DataAuthContext
): Promise<unknown> {
  assertValidIdentifier(functionName, "RPC function");
  const schemaIdent = quoteIdent(project.schema_name);
  const fnIdent = quoteIdent(functionName);

  const params: unknown[] = [];
  let argCallSql = "";

  if (Array.isArray(args)) {
    const placeholders = args.map((val) => {
      params.push(val);
      return `$${params.length}`;
    });
    argCallSql = placeholders.join(", ");
  } else if (args && typeof args === "object") {
    const entries = Object.entries(args);
    const namedPlaceholders = entries.map(([k, val]) => {
      assertValidIdentifier(k, "RPC parameter");
      params.push(val);
      return `${quoteIdent(k)} := $${params.length}`;
    });
    argCallSql = namedPlaceholders.join(", ");
  }

  const rows = await withRlsTransaction(
    {
      schemaName: project.schema_name,
      dbRoleName: project.db_role_name,
      role: auth.role,
      userId: auth.userId ?? null,
      email: auth.email ?? null,
      projectId: project.id,
      claims: auth.claims,
      bypassRls: auth.role === "service_role",
    },
    async (client) => {
      const res = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${schemaIdent}.${fnIdent}(${argCallSql})`,
        params
      );
      return res.rows;
    }
  );

  await incrementProjectMetric(project.id, "rpc_requests", 1);
  if (rows.length === 1 && Object.keys(rows[0]!).length === 1) {
    const firstKey = Object.keys(rows[0]!)[0]!;
    if (firstKey === functionName) {
      return rows[0]![firstKey];
    }
  }
  return rows;
}

export async function generateProjectOpenApiSpec(
  project: ProjectRecord
): Promise<Record<string, unknown>> {
  const tables = await inspectProjectSchema(project);
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {};

  for (const t of tables) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const col of t.columns) {
      let openApiType = "string";
      if (
        col.dataType.includes("int") ||
        col.udtName === "int4" ||
        col.udtName === "int8"
      ) {
        openApiType = "integer";
      } else if (
        col.dataType === "numeric" ||
        col.dataType === "real" ||
        col.dataType === "double precision"
      ) {
        openApiType = "number";
      } else if (col.dataType === "boolean") {
        openApiType = "boolean";
      } else if (col.dataType === "json" || col.dataType === "jsonb") {
        openApiType = "object";
      }

      properties[col.name] = {
        type: openApiType,
        nullable: col.isNullable,
        default: col.defaultValue ?? undefined,
      };
      if (!col.isNullable && !col.defaultValue) {
        required.push(col.name);
      }
    }

    schemas[t.name] = {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
    };

    paths[`/v1/projects/${project.slug}/rest/${t.name}`] = {
      get: {
        summary: `Query rows from ${t.name}`,
        parameters: [
          {
            name: "select",
            in: "query",
            schema: { type: "string", default: "*" },
          },
          { name: "order", in: "query", schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 100 },
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0 },
          },
        ],
        responses: {
          "200": {
            description: `Array of ${t.name} records`,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: {
                      type: "array",
                      items: { $ref: `#/components/schemas/${t.name}` },
                    },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        summary: `Insert row(s) into ${t.name}`,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: `#/components/schemas/${t.name}` },
            },
          },
        },
        responses: {
          "201": { description: `Created ${t.name} record(s)` },
        },
      },
      patch: {
        summary: `Update matching row(s) in ${t.name}`,
        responses: {
          "200": { description: `Updated ${t.name} record(s)` },
        },
      },
      delete: {
        summary: `Delete matching row(s) from ${t.name}`,
        responses: {
          "200": { description: `Deleted ${t.name} record(s)` },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${project.name} — MAARY BASE Data API`,
      version: "1.0.0",
      description: `Auto-generated OpenAPI specification for project '${project.slug}' (schema: ${project.schema_name}).`,
    },
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "apikey",
        },
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas,
    },
  };
}
