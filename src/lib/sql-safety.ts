import { ForbiddenError, ValidationError } from "./errors.js";

const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export function isValidIdentifier(identifier: string): boolean {
  return IDENTIFIER_REGEX.test(identifier);
}

export function assertValidIdentifier(
  identifier: string,
  label = "identifier"
): string {
  if (!isValidIdentifier(identifier)) {
    throw new ValidationError(
      `Invalid SQL ${label} '${identifier}'. Must start with a letter or underscore and contain only alphanumeric characters and underscores (max 63 chars).`
    );
  }
  return identifier;
}

export function quoteIdent(identifier: string): string {
  assertValidIdentifier(identifier);
  return `"${identifier.replace(/"/g, '""')}"`;
}

export function toProjectSchemaName(slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 48);
  const schemaName = `proj_${sanitized || "default"}`;
  assertValidIdentifier(schemaName, "schema");
  return schemaName;
}

export interface SqlSafetyAnalysis {
  isReadOnly: boolean;
  isDestructive: boolean;
  touchesPlatformTables: boolean;
  attemptsRoleEscalation: boolean;
  reason?: string;
}

export function analyzeProjectSql(sql: string): SqlSafetyAnalysis {
  // Strip SQL comments for inspection, but ALSO inspect raw SQL so dollar-quoted blocks cannot hide role switches
  const cleaned = sql
    .replace(/--.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();

  const normalized = cleaned.toLowerCase();
  const rawLower = sql.toLowerCase();

  // Check if query touches internal platform metadata tables or system catalogs
  const touchesPlatformTables =
    /\bplatform_[a-z0-9_]+\b/i.test(cleaned) ||
    /\bproject_auth_[a-z0-9_]+\b/i.test(cleaned) ||
    /\bpg_shadow\b/i.test(cleaned) ||
    /\bpg_authid\b/i.test(cleaned) ||
    /\b_marry_base_service_role_bypass\b/i.test(rawLower);

  // Check both comment-stripped and raw SQL (including inside $$ blocks) for role/session escalation
  const roleEscalationRegex =
    /\b(set\s+(session\s+|local\s+)?role|reset\s+role|reset\s+all|set\s+session\s+authorization|reset\s+session\s+authorization|alter\s+role|create\s+role|drop\s+role|grant\s+.*superuser|alter\s+system|copy\s+.*\bfrom\s+program|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_execute_server_program|set_config\s*\(\s*['"]role['"])\b/i;

  const attemptsRoleEscalation =
    roleEscalationRegex.test(cleaned) || roleEscalationRegex.test(rawLower);

  // Check if query is destructive
  const isDestructive =
    /\b(drop\s+table|drop\s+schema|drop\s+database|truncate\s+|delete\s+from\s+[a-z0-9_."]+\s*(?:;|$))/i.test(
      cleaned
    );

  const isWrite =
    /\b(insert|update|delete|create|alter|drop|truncate|grant|revoke|comment|vacuum|analyze|refresh|do|call)\b/i.test(
      normalized
    );

  return {
    isReadOnly: !isWrite,
    isDestructive,
    touchesPlatformTables,
    attemptsRoleEscalation,
  };
}

export function assertProjectSqlSafe(
  sql: string,
  options: {
    readOnly?: boolean;
    allowDestructive?: boolean;
    targetSchema?: string;
  } = {}
): SqlSafetyAnalysis {
  if (!sql || !sql.trim()) {
    throw new ValidationError("SQL query cannot be empty.");
  }

  const analysis = analyzeProjectSql(sql);

  if (analysis.touchesPlatformTables) {
    throw new ForbiddenError(
      "Project SQL queries are isolated and cannot access platform control-plane tables."
    );
  }

  if (analysis.attemptsRoleEscalation) {
    throw new ForbiddenError(
      "Project SQL queries cannot modify database roles, session authorization, or system settings."
    );
  }

  // Prevent cross-project schema references (`proj_other`)
  if (options.targetSchema) {
    const schemaMatches = sql.match(/\bproj_[a-z0-9_]+\b/gi) || [];
    for (const match of schemaMatches) {
      if (match.toLowerCase() !== options.targetSchema.toLowerCase()) {
        throw new ForbiddenError(
          `Cross-project schema access to '${match}' is forbidden.`
        );
      }
    }
  }

  if (options.readOnly && !analysis.isReadOnly) {
    throw new ForbiddenError(
      "Write statements are not permitted in read-only SQL execution mode."
    );
  }

  if (analysis.isDestructive && !options.allowDestructive) {
    throw new ValidationError(
      "Destructive SQL operation detected (DROP, TRUNCATE, or unfiltered DELETE). Pass allowDestructive=true to confirm execution."
    );
  }

  return analysis;
}
