import { pool } from "../db/pool.js";

export interface AuditEventInput {
  projectId?: string | null;
  actorType: "system" | "user" | "service";
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: string;
  project_id: string | null;
  actor_type: "system" | "user" | "service";
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function recordAuditEvent(
  event: AuditEventInput
): Promise<AuditEventRecord> {
  const res = await pool.query<AuditEventRecord>(
    `INSERT INTO platform_audit_events (
      project_id, actor_type, actor_id, action, resource_type, resource_id, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    RETURNING *`,
    [
      event.projectId ?? null,
      event.actorType,
      event.actorId ?? null,
      event.action,
      event.resourceType,
      event.resourceId ?? null,
      JSON.stringify(event.metadata ?? {}),
    ]
  );
  return res.rows[0]!;
}

export async function listAuditEvents(filters: {
  projectId?: string;
  action?: string;
  actorType?: string;
  resourceType?: string;
  limit?: number;
  offset?: number;
}): Promise<{ events: AuditEventRecord[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.projectId) {
    params.push(filters.projectId);
    conditions.push(`project_id = $${params.length}`);
  }
  if (filters.action) {
    params.push(filters.action);
    conditions.push(`action = $${params.length}`);
  }
  if (filters.actorType) {
    params.push(filters.actorType);
    conditions.push(`actor_type = $${params.length}`);
  }
  if (filters.resourceType) {
    params.push(filters.resourceType);
    conditions.push(`resource_type = $${params.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM platform_audit_events ${whereClause}`,
    params
  );
  const total = Number(countRes.rows[0]?.count ?? 0);

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const queryParams = [...params, limit, offset];

  const rowsRes = await pool.query<AuditEventRecord>(
    `SELECT * FROM platform_audit_events ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
    queryParams
  );

  return { events: rowsRes.rows, total };
}

export async function incrementProjectMetric(
  projectId: string,
  metricName: string,
  delta = 1
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO platform_metrics_counters (project_id, metric_name, metric_value, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (project_id, metric_name)
       DO UPDATE SET metric_value = platform_metrics_counters.metric_value + $3, updated_at = now()`,
      [projectId, metricName, delta]
    );
  } catch {
    // Non-blocking metrics update
  }
}

export async function getProjectMetrics(
  projectId: string
): Promise<Record<string, number>> {
  const res = await pool.query<{ metric_name: string; metric_value: string }>(
    `SELECT metric_name, metric_value::text FROM platform_metrics_counters WHERE project_id = $1`,
    [projectId]
  );
  const out: Record<string, number> = {};
  for (const row of res.rows) {
    out[row.metric_name] = Number(row.metric_value);
  }
  return out;
}
