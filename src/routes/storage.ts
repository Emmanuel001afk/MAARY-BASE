import type { FastifyInstance, FastifyRequest } from "fastify";
import { ValidationError } from "../lib/errors.js";
import {
  requireProjectControlAccess,
  resolveProjectServiceAuth,
} from "../middleware/auth.middleware.js";
import {
  cleanupAbandonedMultipartUploads,
  completeMultipartUpload,
  createSignedStorageUrl,
  createStorageBucket,
  createStoragePolicy,
  deleteStorageBucket,
  deleteStorageObject,
  deleteStoragePolicy,
  downloadStorageObject,
  getStorageBucketByName,
  initiateMultipartUpload,
  listStorageBuckets,
  listStorageObjects,
  listStoragePolicies,
  updateStorageBucket,
  uploadMultipartPart,
  uploadStorageObject,
  verifySignedStorageOperation,
} from "../services/storage.service.js";

function extractPayloadBufferAndMeta(req: FastifyRequest): {
  buffer: Buffer;
  mimeType: string;
  metadata?: Record<string, unknown>;
  upsert: boolean;
} {
  const q = (req.query ?? {}) as { upsert?: string };
  const body = req.body;
  const contentTypeHeader =
    (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();

  if (Buffer.isBuffer(body)) {
    return {
      buffer: body,
      mimeType: contentTypeHeader,
      upsert: q.upsert !== "false",
    };
  }

  if (typeof body === "string") {
    return {
      buffer: Buffer.from(body, "utf8"),
      mimeType: contentTypeHeader,
      upsert: q.upsert !== "false",
    };
  }

  if (body && typeof body === "object") {
    const obj = body as {
      contentBase64?: string;
      content?: string;
      mimeType?: string;
      metadata?: Record<string, unknown>;
      upsert?: boolean;
    };
    if (typeof obj.contentBase64 === "string") {
      return {
        buffer: Buffer.from(obj.contentBase64, "base64"),
        mimeType: obj.mimeType ?? "application/octet-stream",
        metadata: obj.metadata,
        upsert: obj.upsert ?? q.upsert !== "false",
      };
    }
    if (typeof obj.content === "string") {
      return {
        buffer: Buffer.from(obj.content, "utf8"),
        mimeType: obj.mimeType ?? "text/plain",
        metadata: obj.metadata,
        upsert: obj.upsert ?? q.upsert !== "false",
      };
    }
    return {
      buffer: Buffer.from(JSON.stringify(body), "utf8"),
      mimeType: "application/json",
      upsert: q.upsert !== "false",
    };
  }

  throw new ValidationError("Upload request body is required.");
}

export async function registerStorageRoutes(
  app: FastifyInstance
): Promise<void> {
  // Buckets Management
  app.get("/v1/projects/:projectRef/storage/buckets", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await resolveProjectServiceAuth(request, projectRef, {
      requiredScope: "storage:read",
    });
    const buckets = await listStorageBuckets(project.id);
    return { buckets };
  });

  app.post(
    "/v1/projects/:projectRef/storage/buckets",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        name?: string;
        public?: boolean;
        fileSizeLimitBytes?: number;
        quotaBytes?: number;
        allowedMimeTypes?: string[];
      };
      if (!body.name) {
        throw new ValidationError("Bucket 'name' is required.");
      }
      const bucket = await createStorageBucket(project, {
        name: body.name,
        public: body.public,
        fileSizeLimitBytes: body.fileSizeLimitBytes,
        quotaBytes: body.quotaBytes,
        allowedMimeTypes: body.allowedMimeTypes,
        actorId: platformUser?.id ?? null,
      });
      return reply.code(201).send({ bucket });
    }
  );

  app.get(
    "/v1/projects/:projectRef/storage/buckets/:bucketName",
    async (request) => {
      const { projectRef, bucketName } = request.params as {
        projectRef: string;
        bucketName: string;
      };
      const { project } = await resolveProjectServiceAuth(request, projectRef, {
        requiredScope: "storage:read",
      });
      const bucket = await getStorageBucketByName(project.id, bucketName);
      return { bucket };
    }
  );

  app.patch(
    "/v1/projects/:projectRef/storage/buckets/:bucketName",
    async (request) => {
      const { projectRef, bucketName } = request.params as {
        projectRef: string;
        bucketName: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as any;
      const bucket = await updateStorageBucket(
        project.id,
        bucketName,
        body,
        platformUser?.id ?? null
      );
      return { bucket };
    }
  );

  app.delete(
    "/v1/projects/:projectRef/storage/buckets/:bucketName",
    async (request) => {
      const { projectRef, bucketName } = request.params as {
        projectRef: string;
        bucketName: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin"]
      );
      const q = (request.query ?? {}) as { force?: string };
      await deleteStorageBucket(
        project.id,
        bucketName,
        q.force === "true",
        platformUser?.id ?? null
      );
      return { deleted: true, bucketName };
    }
  );

  // Storage Policies
  app.get(
    "/v1/projects/:projectRef/storage/buckets/:bucketName/policies",
    async (request) => {
      const { projectRef, bucketName } = request.params as {
        projectRef: string;
        bucketName: string;
      };
      const { project } = await requireProjectControlAccess(
        request,
        projectRef
      );
      const policies = await listStoragePolicies(project.id, bucketName);
      return { policies };
    }
  );

  app.post(
    "/v1/projects/:projectRef/storage/buckets/:bucketName/policies",
    async (request, reply) => {
      const { projectRef, bucketName } = request.params as {
        projectRef: string;
        bucketName: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        name?: string;
        operation?: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
        roles?: string[];
        pathPrefix?: string;
        allowOwnerOnly?: boolean;
      };
      if (!body.name || !body.operation) {
        throw new ValidationError("Policy 'name' and 'operation' are required.");
      }
      const policy = await createStoragePolicy(project.id, bucketName, {
        name: body.name,
        operation: body.operation,
        roles: body.roles,
        pathPrefix: body.pathPrefix,
        allowOwnerOnly: body.allowOwnerOnly,
        actorId: platformUser?.id ?? null,
      });
      return reply.code(201).send({ policy });
    }
  );

  app.delete(
    "/v1/projects/:projectRef/storage/buckets/:bucketName/policies/:policyId",
    async (request) => {
      const { projectRef, bucketName, policyId } = request.params as {
        projectRef: string;
        bucketName: string;
        policyId: string;
      };
      const { project, platformUser } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      await deleteStoragePolicy(
        project.id,
        bucketName,
        policyId,
        platformUser?.id ?? null
      );
      return { deleted: true };
    }
  );

  // List Objects in Bucket
  app.get(
    "/v1/projects/:projectRef/storage/buckets/:bucketName/objects",
    async (request) => {
      const { projectRef, bucketName } = request.params as {
        projectRef: string;
        bucketName: string;
      };
      const { project, auth } = await resolveProjectServiceAuth(
        request,
        projectRef,
        { allowAnonymousWithoutKey: true }
      );
      const q = (request.query ?? {}) as {
        prefix?: string;
        limit?: string;
        offset?: string;
      };
      const objects = await listStorageObjects(project, bucketName, {
        prefix: q.prefix,
        limit: q.limit ? Number(q.limit) : 100,
        offset: q.offset ? Number(q.offset) : 0,
        auth,
      });
      return { objects };
    }
  );

  // Upload Object
  app.post(
    "/v1/projects/:projectRef/storage/buckets/:bucketName/objects/*",
    async (request, reply) => {
      const params = request.params as {
        projectRef: string;
        bucketName: string;
        "*": string;
      };
      const { project, auth } = await resolveProjectServiceAuth(
        request,
        params.projectRef,
        { requiredScope: "storage:write" }
      );
      const { buffer, mimeType, metadata, upsert } =
        extractPayloadBufferAndMeta(request);
      const object = await uploadStorageObject(
        project,
        params.bucketName,
        params["*"],
        buffer,
        {
          mimeType,
          metadata,
          upsert,
          auth,
        }
      );
      return reply.code(201).send({ object });
    }
  );

  // Download Object (or inspect metadata with ?metadata=true)
  app.get(
    "/v1/projects/:projectRef/storage/buckets/:bucketName/objects/*",
    async (request, reply) => {
      const params = request.params as {
        projectRef: string;
        bucketName: string;
        "*": string;
      };
      const { project, auth } = await resolveProjectServiceAuth(
        request,
        params.projectRef,
        { allowAnonymousWithoutKey: true }
      );
      const { object, data } = await downloadStorageObject(
        project,
        params.bucketName,
        params["*"],
        { auth }
      );
      const q = (request.query ?? {}) as { metadata?: string };
      if (q.metadata === "true") {
        return { object };
      }
      return reply
        .header("content-type", object.mime_type)
        .header("content-length", String(object.size_bytes))
        .header("etag", object.etag)
        .header("x-content-sha256", object.checksum_sha256)
        .send(data);
    }
  );

  // Delete Object
  app.delete(
    "/v1/projects/:projectRef/storage/buckets/:bucketName/objects/*",
    async (request) => {
      const params = request.params as {
        projectRef: string;
        bucketName: string;
        "*": string;
      };
      const { project, auth } = await resolveProjectServiceAuth(
        request,
        params.projectRef,
        { requiredScope: "storage:write" }
      );
      const object = await deleteStorageObject(
        project,
        params.bucketName,
        params["*"],
        auth
      );
      return { deleted: true, object };
    }
  );

  // Create Signed URL
  app.post(
    "/v1/projects/:projectRef/storage/buckets/:bucketName/sign/*",
    async (request) => {
      const params = request.params as {
        projectRef: string;
        bucketName: string;
        "*": string;
      };
      const { project, auth } = await resolveProjectServiceAuth(
        request,
        params.projectRef,
        { requiredScope: "storage:read" }
      );
      const body = (request.body ?? {}) as {
        operation?: "download" | "upload";
        expiresIn?: number;
      };
      return createSignedStorageUrl(
        project,
        params.bucketName,
        params["*"],
        {
          operation: body.operation ?? "download",
          expiresInSeconds: body.expiresIn ?? 3600,
          auth,
        }
      );
    }
  );

  // Execute Signed Download URL
  app.get(
    "/v1/projects/:projectRef/storage/signed/download",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project } = await resolveProjectServiceAuth(request, projectRef, {
        allowAnonymousWithoutKey: true,
      });
      const q = (request.query ?? {}) as { token?: string };
      if (!q.token) {
        throw new ValidationError("Signed URL 'token' is required.");
      }
      const { bucketName, objectPath } = await verifySignedStorageOperation(
        project,
        q.token,
        "download"
      );
      const { object, data } = await downloadStorageObject(
        project,
        bucketName,
        objectPath,
        {
          auth: { role: "service_role" },
          bypassPolicy: true,
        }
      );
      return reply
        .header("content-type", object.mime_type)
        .header("content-length", String(object.size_bytes))
        .header("etag", object.etag)
        .header("x-content-sha256", object.checksum_sha256)
        .send(data);
    }
  );

  // Execute Signed Upload URL
  app.post(
    "/v1/projects/:projectRef/storage/signed/upload",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project } = await resolveProjectServiceAuth(request, projectRef, {
        allowAnonymousWithoutKey: true,
      });
      const q = (request.query ?? {}) as { token?: string };
      if (!q.token) {
        throw new ValidationError("Signed URL 'token' is required.");
      }
      const { bucketName, objectPath } = await verifySignedStorageOperation(
        project,
        q.token,
        "upload"
      );
      const { buffer, mimeType, metadata } =
        extractPayloadBufferAndMeta(request);
      const object = await uploadStorageObject(
        project,
        bucketName,
        objectPath,
        buffer,
        {
          mimeType,
          metadata,
          upsert: true,
          auth: { role: "service_role" },
          bypassPolicy: true,
        }
      );
      return reply.code(201).send({ object });
    }
  );

  // Multipart / Resumable Uploads
  app.post(
    "/v1/projects/:projectRef/storage/multipart/initiate",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project, auth } = await resolveProjectServiceAuth(
        request,
        projectRef,
        { requiredScope: "storage:write" }
      );
      const body = (request.body ?? {}) as {
        bucketName?: string;
        path?: string;
        mimeType?: string;
        metadata?: Record<string, unknown>;
      };
      if (!body.bucketName || !body.path) {
        throw new ValidationError("'bucketName' and 'path' are required.");
      }
      const session = await initiateMultipartUpload(
        project,
        body.bucketName,
        body.path,
        {
          mimeType: body.mimeType,
          metadata: body.metadata,
          auth,
        }
      );
      return reply.code(201).send({ upload: session });
    }
  );

  app.post(
    "/v1/projects/:projectRef/storage/multipart/:uploadId/parts/:partNumber",
    async (request) => {
      const { projectRef, uploadId, partNumber } = request.params as {
        projectRef: string;
        uploadId: string;
        partNumber: string;
      };
      const { project } = await resolveProjectServiceAuth(request, projectRef, {
        requiredScope: "storage:write",
      });
      const { buffer } = extractPayloadBufferAndMeta(request);
      const part = await uploadMultipartPart(
        project,
        uploadId,
        Number(partNumber),
        buffer
      );
      return { part };
    }
  );

  app.post(
    "/v1/projects/:projectRef/storage/multipart/:uploadId/complete",
    async (request, reply) => {
      const { projectRef, uploadId } = request.params as {
        projectRef: string;
        uploadId: string;
      };
      const { project, auth } = await resolveProjectServiceAuth(
        request,
        projectRef,
        { requiredScope: "storage:write" }
      );
      const object = await completeMultipartUpload(project, uploadId, auth);
      return reply.code(201).send({ object });
    }
  );

  app.post(
    "/v1/projects/:projectRef/storage/multipart/cleanup",
    async (request) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      return cleanupAbandonedMultipartUploads(project.id);
    }
  );
}
