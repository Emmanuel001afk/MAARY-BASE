import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { signStorageToken, verifyStorageToken } from "../lib/crypto.js";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  QuotaExceededError,
  ValidationError,
} from "../lib/errors.js";
import { incrementProjectMetric, recordAuditEvent } from "./audit.service.js";
import type { DataAuthContext } from "./data-api.service.js";
import type { ProjectRecord } from "./project.service.js";

export interface StorageBackendAdapter {
  putObject(storageKey: string, data: Buffer, mimeType: string): Promise<void>;
  getObject(storageKey: string): Promise<Buffer>;
  deleteObject(storageKey: string): Promise<void>;
}

class LocalFilesystemAdapter implements StorageBackendAdapter {
  constructor(private readonly baseDir: string) {}

  private resolveSafePath(storageKey: string): string {
    const root = resolve(this.baseDir);
    const target = resolve(root, normalize(storageKey));
    if (!target.startsWith(root + "/") && target !== root) {
      throw new ForbiddenError("Invalid storage key path.");
    }
    return target;
  }

  async putObject(
    storageKey: string,
    data: Buffer,
    _mimeType: string
  ): Promise<void> {
    const fullPath = this.resolveSafePath(storageKey);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
  }

  async getObject(storageKey: string): Promise<Buffer> {
    const fullPath = this.resolveSafePath(storageKey);
    try {
      return await readFile(fullPath);
    } catch {
      throw new NotFoundError("Stored file blob not found on storage backend.");
    }
  }

  async deleteObject(storageKey: string): Promise<void> {
    const fullPath = this.resolveSafePath(storageKey);
    await rm(fullPath, { force: true });
  }
}

export const storageAdapter: StorageBackendAdapter = new LocalFilesystemAdapter(
  config.STORAGE_DIR
);

export interface StorageBucketRecord {
  id: string;
  project_id: string;
  name: string;
  public: boolean;
  file_size_limit_bytes: number;
  quota_bytes: number;
  allowed_mime_types: string[];
  created_at: string;
  updated_at: string;
}

export interface StorageObjectRecord {
  id: string;
  project_id: string;
  bucket_id: string;
  path: string;
  size_bytes: number;
  mime_type: string;
  checksum_sha256: string;
  etag: string;
  storage_key: string;
  metadata: Record<string, unknown>;
  owner_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface StoragePolicyRecord {
  id: string;
  project_id: string;
  bucket_id: string;
  name: string;
  operation: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  roles: string[];
  path_prefix: string;
  allow_owner_only: boolean;
  created_at: string;
}

function normalizeObjectPath(rawPath: string): string {
  const cleaned = rawPath.trim().replace(/^\/+/, "");
  if (
    !cleaned ||
    cleaned.includes("..") ||
    cleaned.includes("\\") ||
    cleaned.includes("\0")
  ) {
    throw new ValidationError(`Invalid storage object path '${rawPath}'.`);
  }
  return cleaned;
}

function normalizeBucketRow(row: any): StorageBucketRecord {
  return {
    ...row,
    file_size_limit_bytes: Number(row.file_size_limit_bytes),
    quota_bytes: Number(row.quota_bytes),
    allowed_mime_types: Array.isArray(row.allowed_mime_types)
      ? row.allowed_mime_types
      : [],
  };
}

function normalizeObjectRow(row: any): StorageObjectRecord {
  return {
    ...row,
    size_bytes: Number(row.size_bytes),
    version: Number(row.version),
  };
}

export async function createStorageBucket(
  project: ProjectRecord,
  input: {
    name: string;
    public?: boolean;
    fileSizeLimitBytes?: number;
    quotaBytes?: number;
    allowedMimeTypes?: string[];
    actorId?: string | null;
  }
): Promise<StorageBucketRecord> {
  const name = input.name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(name)) {
    throw new ValidationError(
      "Bucket name must be 3-63 lowercase alphanumeric characters, dots, underscores, or hyphens."
    );
  }

  const existing = await pool.query(
    "SELECT id FROM platform_storage_buckets WHERE project_id = $1 AND name = $2",
    [project.id, name]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    throw new ConflictError(`Bucket '${name}' already exists in this project.`);
  }

  const res = await pool.query(
    `INSERT INTO platform_storage_buckets (
      project_id, name, public, file_size_limit_bytes, quota_bytes, allowed_mime_types
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    RETURNING *`,
    [
      project.id,
      name,
      Boolean(input.public),
      input.fileSizeLimitBytes ?? config.MAX_UPLOAD_BYTES,
      input.quotaBytes ?? project.quotas.maxStorageBytes,
      JSON.stringify(input.allowedMimeTypes ?? []),
    ]
  );

  await recordAuditEvent({
    projectId: project.id,
    actorType: input.actorId ? "user" : "service",
    actorId: input.actorId ?? null,
    action: "storage.bucket.created",
    resourceType: "storage_bucket",
    resourceId: res.rows[0]!.id,
    metadata: { name, public: Boolean(input.public) },
  });

  return normalizeBucketRow(res.rows[0]);
}

export async function listStorageBuckets(
  projectId: string
): Promise<Array<StorageBucketRecord & { used_bytes: number; object_count: number }>> {
  const res = await pool.query(
    `SELECT b.*,
       COALESCE(SUM(o.size_bytes), 0)::bigint AS used_bytes,
       COUNT(o.id)::int AS object_count
     FROM platform_storage_buckets b
     LEFT JOIN platform_storage_objects o ON o.bucket_id = b.id
     WHERE b.project_id = $1
     GROUP BY b.id
     ORDER BY b.name ASC`,
    [projectId]
  );
  return res.rows.map((r) => ({
    ...normalizeBucketRow(r),
    used_bytes: Number(r.used_bytes),
    object_count: Number(r.object_count),
  }));
}

export async function getStorageBucketByName(
  projectId: string,
  bucketName: string
): Promise<StorageBucketRecord> {
  const res = await pool.query(
    `SELECT * FROM platform_storage_buckets WHERE project_id = $1 AND name = $2`,
    [projectId, bucketName]
  );
  if (!res.rows[0]) {
    throw new NotFoundError(`Storage bucket '${bucketName}' not found.`);
  }
  return normalizeBucketRow(res.rows[0]);
}

export async function updateStorageBucket(
  projectId: string,
  bucketName: string,
  updates: {
    public?: boolean;
    fileSizeLimitBytes?: number;
    quotaBytes?: number;
    allowedMimeTypes?: string[];
  },
  actorId?: string | null
): Promise<StorageBucketRecord> {
  const bucket = await getStorageBucketByName(projectId, bucketName);
  const res = await pool.query(
    `UPDATE platform_storage_buckets
     SET public = $1,
         file_size_limit_bytes = $2,
         quota_bytes = $3,
         allowed_mime_types = $4::jsonb,
         updated_at = now()
     WHERE id = $5
     RETURNING *`,
    [
      updates.public ?? bucket.public,
      updates.fileSizeLimitBytes ?? bucket.file_size_limit_bytes,
      updates.quotaBytes ?? bucket.quota_bytes,
      JSON.stringify(updates.allowedMimeTypes ?? bucket.allowed_mime_types),
      bucket.id,
    ]
  );

  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "service",
    actorId: actorId ?? null,
    action: "storage.bucket.updated",
    resourceType: "storage_bucket",
    resourceId: bucket.id,
    metadata: { name: bucketName },
  });

  return normalizeBucketRow(res.rows[0]);
}

export async function deleteStorageBucket(
  projectId: string,
  bucketName: string,
  force = false,
  actorId?: string | null
): Promise<void> {
  const bucket = await getStorageBucketByName(projectId, bucketName);
  const objectsRes = await pool.query<StorageObjectRecord>(
    `SELECT * FROM platform_storage_objects WHERE bucket_id = $1`,
    [bucket.id]
  );
  if (objectsRes.rows.length > 0 && !force) {
    throw new ConflictError(
      `Bucket '${bucketName}' is not empty (${objectsRes.rows.length} objects). Empty the bucket or pass force=true.`
    );
  }

  for (const obj of objectsRes.rows) {
    await storageAdapter.deleteObject(obj.storage_key);
  }

  await pool.query(`DELETE FROM platform_storage_buckets WHERE id = $1`, [
    bucket.id,
  ]);

  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "service",
    actorId: actorId ?? null,
    action: "storage.bucket.deleted",
    resourceType: "storage_bucket",
    resourceId: bucket.id,
    metadata: { name: bucketName },
  });
}

// Storage Access Policies
export async function createStoragePolicy(
  projectId: string,
  bucketName: string,
  input: {
    name: string;
    operation: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
    roles?: string[];
    pathPrefix?: string;
    allowOwnerOnly?: boolean;
    actorId?: string | null;
  }
): Promise<StoragePolicyRecord> {
  const bucket = await getStorageBucketByName(projectId, bucketName);
  const res = await pool.query<StoragePolicyRecord>(
    `INSERT INTO platform_storage_policies (
      project_id, bucket_id, name, operation, roles, path_prefix, allow_owner_only
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
    ON CONFLICT (bucket_id, name)
    DO UPDATE SET
      operation = EXCLUDED.operation,
      roles = EXCLUDED.roles,
      path_prefix = EXCLUDED.path_prefix,
      allow_owner_only = EXCLUDED.allow_owner_only
    RETURNING *`,
    [
      projectId,
      bucket.id,
      input.name.trim(),
      input.operation,
      JSON.stringify(input.roles ?? ["authenticated"]),
      (input.pathPrefix ?? "").replace(/^\/+/, ""),
      Boolean(input.allowOwnerOnly),
    ]
  );

  await recordAuditEvent({
    projectId,
    actorType: input.actorId ? "user" : "service",
    actorId: input.actorId ?? null,
    action: "storage.policy.created",
    resourceType: "storage_policy",
    resourceId: res.rows[0]!.id,
    metadata: { bucketName, name: input.name, operation: input.operation },
  });

  return res.rows[0]!;
}

export async function listStoragePolicies(
  projectId: string,
  bucketName: string
): Promise<StoragePolicyRecord[]> {
  const bucket = await getStorageBucketByName(projectId, bucketName);
  const res = await pool.query<StoragePolicyRecord>(
    `SELECT * FROM platform_storage_policies WHERE bucket_id = $1 ORDER BY created_at ASC`,
    [bucket.id]
  );
  return res.rows;
}

export async function deleteStoragePolicy(
  projectId: string,
  bucketName: string,
  policyNameOrId: string,
  actorId?: string | null
): Promise<void> {
  const bucket = await getStorageBucketByName(projectId, bucketName);
  const res = await pool.query(
    `DELETE FROM platform_storage_policies
     WHERE bucket_id = $1 AND (id::text = $2 OR name = $2)
     RETURNING id`,
    [bucket.id, policyNameOrId]
  );
  if (!res.rowCount) {
    throw new NotFoundError("Storage policy not found.");
  }
  await recordAuditEvent({
    projectId,
    actorType: actorId ? "user" : "service",
    actorId: actorId ?? null,
    action: "storage.policy.deleted",
    resourceType: "storage_policy",
    resourceId: policyNameOrId,
  });
}

async function assertStorageAccess(
  bucket: StorageBucketRecord,
  objectPath: string,
  operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE",
  auth: DataAuthContext,
  existingOwnerId?: string | null
): Promise<void> {
  if (auth.role === "service_role") {
    return;
  }

  if (operation === "SELECT" && bucket.public) {
    return;
  }

  const policies = await pool.query<StoragePolicyRecord>(
    `SELECT * FROM platform_storage_policies WHERE bucket_id = $1`,
    [bucket.id]
  );

  for (const pol of policies.rows) {
    if (pol.operation !== "ALL" && pol.operation !== operation) {
      continue;
    }
    const roles = Array.isArray(pol.roles) ? pol.roles : [];
    if (
      !roles.includes("*") &&
      !roles.includes("PUBLIC") &&
      !roles.includes(auth.role)
    ) {
      continue;
    }
    if (pol.path_prefix && !objectPath.startsWith(pol.path_prefix)) {
      continue;
    }
    if (pol.allow_owner_only) {
      if (!auth.userId) continue;
      if (
        existingOwnerId !== undefined &&
        existingOwnerId !== null &&
        existingOwnerId !== auth.userId
      ) {
        continue;
      }
    }
    return;
  }

  throw new ForbiddenError(
    `Storage access policy denied ${operation} on '${bucket.name}/${objectPath}' for role '${auth.role}'.`
  );
}

function validateMimeTypeAllowed(
  mimeType: string,
  allowedList: string[]
): void {
  if (!allowedList || allowedList.length === 0) return;
  const normalized = mimeType.toLowerCase().split(";")[0]!.trim();
  const matched = allowedList.some((pattern) => {
    const p = pattern.toLowerCase().trim();
    if (p === "*/*" || p === "*") return true;
    if (p.endsWith("/*")) {
      const prefix = p.slice(0, -1);
      return normalized.startsWith(prefix);
    }
    return normalized === p;
  });
  if (!matched) {
    throw new ValidationError(
      `MIME type '${mimeType}' is not allowed in this bucket. Allowed: ${allowedList.join(", ")}.`
    );
  }
}

export async function uploadStorageObject(
  project: ProjectRecord,
  bucketName: string,
  rawPath: string,
  data: Buffer,
  options: {
    mimeType?: string;
    metadata?: Record<string, unknown>;
    upsert?: boolean;
    auth: DataAuthContext;
    bypassPolicy?: boolean;
  }
): Promise<StorageObjectRecord> {
  const objectPath = normalizeObjectPath(rawPath);
  const bucket = await getStorageBucketByName(project.id, bucketName);
  const mimeType = options.mimeType || "application/octet-stream";

  validateMimeTypeAllowed(mimeType, bucket.allowed_mime_types);

  if (data.byteLength > bucket.file_size_limit_bytes) {
    throw new QuotaExceededError(
      `File size (${data.byteLength} bytes) exceeds bucket limit (${bucket.file_size_limit_bytes} bytes).`
    );
  }

  const existingRes = await pool.query<StorageObjectRecord>(
    `SELECT * FROM platform_storage_objects WHERE bucket_id = $1 AND path = $2`,
    [bucket.id, objectPath]
  );
  const existing = existingRes.rows[0]
    ? normalizeObjectRow(existingRes.rows[0])
    : null;

  if (existing && options.upsert === false) {
    throw new ConflictError(
      `Object '${objectPath}' already exists in bucket '${bucketName}'. Pass upsert=true to overwrite.`
    );
  }

  if (!options.bypassPolicy) {
    await assertStorageAccess(
      bucket,
      objectPath,
      existing ? "UPDATE" : "INSERT",
      options.auth,
      existing?.owner_id
    );
  }

  // Check bucket & project storage quotas
  const usageRes = await pool.query<{
    bucket_bytes: string;
    project_bytes: string;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN bucket_id = $1 THEN size_bytes ELSE 0 END), 0)::text AS bucket_bytes,
       COALESCE(SUM(size_bytes), 0)::text AS project_bytes
     FROM platform_storage_objects
     WHERE project_id = $2`,
    [bucket.id, project.id]
  );
  const currentBucketBytes =
    Number(usageRes.rows[0]?.bucket_bytes ?? 0) - (existing?.size_bytes ?? 0);
  const currentProjectBytes =
    Number(usageRes.rows[0]?.project_bytes ?? 0) - (existing?.size_bytes ?? 0);

  if (currentBucketBytes + data.byteLength > bucket.quota_bytes) {
    throw new QuotaExceededError(
      `Upload exceeds bucket storage quota (${bucket.quota_bytes} bytes).`
    );
  }
  const projectMaxBytes =
    project.quotas?.maxStorageBytes ?? bucket.quota_bytes;
  if (currentProjectBytes + data.byteLength > projectMaxBytes) {
    throw new QuotaExceededError(
      `Upload exceeds project storage quota (${projectMaxBytes} bytes).`
    );
  }

  const checksum = createHash("sha256").update(data).digest("hex");
  const etag = `"${checksum.slice(0, 32)}"`;
  const storageKey = `${project.id}/${bucket.id}/${existing?.id ?? randomUUID()}`;

  await storageAdapter.putObject(storageKey, data, mimeType);

  const saved = await withTransaction(async (client) => {
    const res = await client.query(
      `INSERT INTO platform_storage_objects (
        project_id, bucket_id, path, size_bytes, mime_type, checksum_sha256, etag, storage_key, metadata, owner_id, version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 1)
      ON CONFLICT (bucket_id, path)
      DO UPDATE SET
        size_bytes = EXCLUDED.size_bytes,
        mime_type = EXCLUDED.mime_type,
        checksum_sha256 = EXCLUDED.checksum_sha256,
        etag = EXCLUDED.etag,
        storage_key = EXCLUDED.storage_key,
        metadata = EXCLUDED.metadata,
        version = platform_storage_objects.version + 1,
        updated_at = now()
      RETURNING *`,
      [
        project.id,
        bucket.id,
        objectPath,
        data.byteLength,
        mimeType,
        checksum,
        etag,
        storageKey,
        JSON.stringify(options.metadata ?? existing?.metadata ?? {}),
        options.auth.userId ?? existing?.owner_id ?? null,
      ]
    );
    return normalizeObjectRow(res.rows[0]);
  });

  if (existing && existing.storage_key !== saved.storage_key) {
    await storageAdapter.deleteObject(existing.storage_key);
  }

  await incrementProjectMetric(project.id, "storage_uploads_total", 1);
  return saved;
}

export async function downloadStorageObject(
  project: ProjectRecord,
  bucketName: string,
  rawPath: string,
  options: {
    auth: DataAuthContext;
    bypassPolicy?: boolean;
  }
): Promise<{ object: StorageObjectRecord; data: Buffer }> {
  const objectPath = normalizeObjectPath(rawPath);
  const bucket = await getStorageBucketByName(project.id, bucketName);
  const objRes = await pool.query(
    `SELECT * FROM platform_storage_objects WHERE bucket_id = $1 AND path = $2`,
    [bucket.id, objectPath]
  );
  if (!objRes.rows[0]) {
    throw new NotFoundError(
      `Object '${objectPath}' not found in bucket '${bucketName}'.`
    );
  }
  const obj = normalizeObjectRow(objRes.rows[0]);

  if (!options.bypassPolicy) {
    await assertStorageAccess(
      bucket,
      objectPath,
      "SELECT",
      options.auth,
      obj.owner_id
    );
  }

  const data = await storageAdapter.getObject(obj.storage_key);
  await incrementProjectMetric(project.id, "storage_downloads_total", 1);
  return { object: obj, data };
}

export async function listStorageObjects(
  project: ProjectRecord,
  bucketName: string,
  options: {
    prefix?: string;
    limit?: number;
    offset?: number;
    auth: DataAuthContext;
  }
): Promise<StorageObjectRecord[]> {
  const bucket = await getStorageBucketByName(project.id, bucketName);
  await assertStorageAccess(
    bucket,
    options.prefix ?? "",
    "SELECT",
    options.auth
  );

  const params: unknown[] = [bucket.id];
  let prefixClause = "";
  if (options.prefix) {
    params.push(`${options.prefix.replace(/^\/+/, "")}%`);
    prefixClause = `AND path LIKE $2`;
  }
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  params.push(limit, offset);

  const res = await pool.query(
    `SELECT * FROM platform_storage_objects
     WHERE bucket_id = $1 ${prefixClause}
     ORDER BY path ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows.map(normalizeObjectRow);
}

export async function deleteStorageObject(
  project: ProjectRecord,
  bucketName: string,
  rawPath: string,
  auth: DataAuthContext
): Promise<StorageObjectRecord> {
  const objectPath = normalizeObjectPath(rawPath);
  const bucket = await getStorageBucketByName(project.id, bucketName);
  const objRes = await pool.query(
    `SELECT * FROM platform_storage_objects WHERE bucket_id = $1 AND path = $2`,
    [bucket.id, objectPath]
  );
  if (!objRes.rows[0]) {
    throw new NotFoundError(
      `Object '${objectPath}' not found in bucket '${bucketName}'.`
    );
  }
  const obj = normalizeObjectRow(objRes.rows[0]);

  await assertStorageAccess(
    bucket,
    objectPath,
    "DELETE",
    auth,
    obj.owner_id
  );

  await pool.query(`DELETE FROM platform_storage_objects WHERE id = $1`, [
    obj.id,
  ]);
  await storageAdapter.deleteObject(obj.storage_key);

  await recordAuditEvent({
    projectId: project.id,
    actorType: auth.userId ? "user" : "service",
    actorId: auth.userId ?? null,
    action: "storage.object.deleted",
    resourceType: "storage_object",
    resourceId: `${bucketName}/${objectPath}`,
  });

  return obj;
}

// Signed URLs
export async function createSignedStorageUrl(
  project: ProjectRecord,
  bucketName: string,
  rawPath: string,
  options: {
    operation?: "download" | "upload";
    expiresInSeconds?: number;
    auth: DataAuthContext;
  }
): Promise<{
  signedUrl: string;
  token: string;
  expiresIn: number;
}> {
  const objectPath = normalizeObjectPath(rawPath);
  const bucket = await getStorageBucketByName(project.id, bucketName);
  const op = options.operation ?? "download";

  await assertStorageAccess(
    bucket,
    objectPath,
    op === "upload" ? "INSERT" : "SELECT",
    options.auth
  );

  const expiresIn = Math.min(
    Math.max(options.expiresInSeconds ?? 3600, 10),
    604800
  );
  const token = signStorageToken(
    {
      projectId: project.id,
      bucketName: bucket.name,
      objectPath,
      operation: op,
    },
    expiresIn
  );

  const signedUrl = `/v1/projects/${project.slug}/storage/signed/${op}?token=${encodeURIComponent(token)}`;
  return { signedUrl, token, expiresIn };
}

export async function verifySignedStorageOperation(
  project: ProjectRecord,
  token: string,
  expectedOperation: "download" | "upload"
): Promise<{ bucketName: string; objectPath: string }> {
  const payload = verifyStorageToken(token);
  if (payload.projectId !== project.id) {
    throw new ForbiddenError("Signed URL token does not belong to this project.");
  }
  if (payload.operation !== expectedOperation) {
    throw new ForbiddenError(
      `Signed URL token is only valid for '${payload.operation}', not '${expectedOperation}'.`
    );
  }
  return {
    bucketName: payload.bucketName,
    objectPath: payload.objectPath,
  };
}

// Multipart / Resumable Uploads for Large Files & Interrupted Transfers
export interface MultipartUploadSession {
  id: string;
  project_id: string;
  bucket_id: string;
  path: string;
  mime_type: string;
  uploaded_parts: Array<{ partNumber: number; sizeBytes: number; checksum: string }>;
  status: "in_progress" | "completed" | "aborted" | "expired";
  expires_at: string;
  created_at: string;
}

export async function initiateMultipartUpload(
  project: ProjectRecord,
  bucketName: string,
  rawPath: string,
  options: {
    mimeType?: string;
    metadata?: Record<string, unknown>;
    auth: DataAuthContext;
  }
): Promise<MultipartUploadSession> {
  const objectPath = normalizeObjectPath(rawPath);
  const bucket = await getStorageBucketByName(project.id, bucketName);
  const mimeType = options.mimeType || "application/octet-stream";
  validateMimeTypeAllowed(mimeType, bucket.allowed_mime_types);

  await assertStorageAccess(bucket, objectPath, "INSERT", options.auth);

  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const res = await pool.query<MultipartUploadSession>(
    `INSERT INTO platform_storage_uploads (
      project_id, bucket_id, path, mime_type, uploaded_parts, owner_id, metadata, status, expires_at
    ) VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, $6::jsonb, 'in_progress', $7)
    RETURNING id, project_id, bucket_id, path, mime_type, uploaded_parts, status, expires_at, created_at`,
    [
      project.id,
      bucket.id,
      objectPath,
      mimeType,
      options.auth.userId ?? null,
      JSON.stringify(options.metadata ?? {}),
      expiresAt,
    ]
  );
  return res.rows[0]!;
}

export async function uploadMultipartPart(
  project: ProjectRecord,
  uploadId: string,
  partNumber: number,
  data: Buffer
): Promise<{ partNumber: number; sizeBytes: number; checksum: string }> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    throw new ValidationError("partNumber must be an integer between 1 and 10000.");
  }
  const sessRes = await pool.query<MultipartUploadSession>(
    `SELECT * FROM platform_storage_uploads WHERE id = $1 AND project_id = $2`,
    [uploadId, project.id]
  );
  const session = sessRes.rows[0];
  if (!session) {
    throw new NotFoundError("Multipart upload session not found.");
  }
  if (session.status !== "in_progress") {
    throw new ValidationError(`Multipart upload session is '${session.status}'.`);
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw new ValidationError("Multipart upload session has expired.");
  }

  const partKey = `${project.id}/_multipart/${uploadId}/part_${partNumber}`;
  await storageAdapter.putObject(partKey, data, "application/octet-stream");
  const checksum = createHash("sha256").update(data).digest("hex");

  const existingParts = Array.isArray(session.uploaded_parts)
    ? session.uploaded_parts.filter((p) => p.partNumber !== partNumber)
    : [];
  const partMeta = { partNumber, sizeBytes: data.byteLength, checksum };
  existingParts.push(partMeta);
  existingParts.sort((a, b) => a.partNumber - b.partNumber);

  await pool.query(
    `UPDATE platform_storage_uploads SET uploaded_parts = $1::jsonb, updated_at = now() WHERE id = $2`,
    [JSON.stringify(existingParts), uploadId]
  );

  return partMeta;
}

export async function completeMultipartUpload(
  project: ProjectRecord,
  uploadId: string,
  auth: DataAuthContext
): Promise<StorageObjectRecord> {
  const sessRes = await pool.query<
    MultipartUploadSession & { metadata: Record<string, unknown>; owner_id: string | null }
  >(
    `SELECT * FROM platform_storage_uploads WHERE id = $1 AND project_id = $2`,
    [uploadId, project.id]
  );
  const session = sessRes.rows[0];
  if (!session || session.status !== "in_progress") {
    throw new NotFoundError("Active multipart upload session not found.");
  }

  const parts = Array.isArray(session.uploaded_parts)
    ? [...session.uploaded_parts].sort((a, b) => a.partNumber - b.partNumber)
    : [];
  if (parts.length === 0) {
    throw new ValidationError("Cannot complete multipart upload with 0 uploaded parts.");
  }

  const buffers: Buffer[] = [];
  for (const p of parts) {
    const partKey = `${project.id}/_multipart/${uploadId}/part_${p.partNumber}`;
    const buf = await storageAdapter.getObject(partKey);
    buffers.push(buf);
  }
  const combined = Buffer.concat(buffers);

  const bucketRes = await pool.query<{ name: string }>(
    `SELECT name FROM platform_storage_buckets WHERE id = $1`,
    [session.bucket_id]
  );
  const bucketName = bucketRes.rows[0]!.name;

  const savedObj = await uploadStorageObject(
    project,
    bucketName,
    session.path,
    combined,
    {
      mimeType: session.mime_type,
      metadata: session.metadata,
      upsert: true,
      auth,
      bypassPolicy: true,
    }
  );

  // Clean up multipart temp chunks
  for (const p of parts) {
    const partKey = `${project.id}/_multipart/${uploadId}/part_${p.partNumber}`;
    await storageAdapter.deleteObject(partKey);
  }

  await pool.query(
    `UPDATE platform_storage_uploads SET status = 'completed', updated_at = now() WHERE id = $1`,
    [uploadId]
  );

  return savedObj;
}

export async function cleanupAbandonedMultipartUploads(
  projectId?: string
): Promise<{ cleanedCount: number }> {
  const params: unknown[] = [];
  let projFilter = "";
  if (projectId) {
    params.push(projectId);
    projFilter = `AND project_id = $1`;
  }

  const expiredRes = await pool.query<MultipartUploadSession>(
    `SELECT * FROM platform_storage_uploads
     WHERE status = 'in_progress' AND expires_at < now() ${projFilter}`,
    params
  );

  for (const sess of expiredRes.rows) {
    const parts = Array.isArray(sess.uploaded_parts) ? sess.uploaded_parts : [];
    for (const p of parts) {
      const partKey = `${sess.project_id}/_multipart/${sess.id}/part_${p.partNumber}`;
      await storageAdapter.deleteObject(partKey);
    }
    await pool.query(
      `UPDATE platform_storage_uploads SET status = 'expired', updated_at = now() WHERE id = $1`,
      [sess.id]
    );
  }

  return { cleanedCount: expiredRes.rows.length };
}
