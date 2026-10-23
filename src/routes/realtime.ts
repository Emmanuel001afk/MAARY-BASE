import type { FastifyInstance } from "fastify";
import { ValidationError } from "../lib/errors.js";
import {
  requireProjectControlAccess,
  resolveProjectServiceAuth,
} from "../middleware/auth.middleware.js";
import {
  createOrUpdateRealtimeChannel,
  listRealtimeChannels,
  listRecentRealtimeEvents,
  realtimeBroker,
} from "../services/realtime.service.js";

export async function registerRealtimeRoutes(
  app: FastifyInstance
): Promise<void> {
  // WebSocket Realtime Endpoint per Project
  app.get(
    "/v1/projects/:projectRef/realtime/ws",
    { websocket: true },
    async (socket, request) => {
      try {
        const { projectRef } = request.params as { projectRef: string };
        const { project, auth, scopes } = await resolveProjectServiceAuth(
          request,
          projectRef,
          { requiredScope: "realtime:subscribe" }
        );
        const client = await realtimeBroker.registerClient(
          project,
          socket,
          auth,
          scopes
        );
        socket.on("message", (raw: Buffer | string) => {
          void realtimeBroker.handleClientMessage(client, raw.toString());
        });
      } catch (err: any) {
        try {
          socket.send(
            JSON.stringify({
              type: "error",
              code: err?.code ?? "unauthorized",
              message: err?.message ?? "Realtime authentication failed.",
            })
          );
          socket.close(1008, err?.message ?? "Unauthorized");
        } catch {
          // Ignore close error
        }
      }
    }
  );

  // Realtime Status & Active Connections
  app.get("/v1/projects/:projectRef/realtime/status", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    return {
      status: "operational",
      deliveryGuarantee: "at-least-once-within-retention-window",
      ...realtimeBroker.getStats(project.id),
    };
  });

  // Channels Configuration
  app.get("/v1/projects/:projectRef/realtime/channels", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await requireProjectControlAccess(request, projectRef);
    const channels = await listRealtimeChannels(project.id);
    return { channels };
  });

  app.post(
    "/v1/projects/:projectRef/realtime/channels",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project } = await requireProjectControlAccess(
        request,
        projectRef,
        ["owner", "admin", "developer"]
      );
      const body = (request.body ?? {}) as {
        topic?: string;
        isPrivate?: boolean;
        config?: Record<string, unknown>;
      };
      if (!body.topic) {
        throw new ValidationError("Channel 'topic' is required.");
      }
      const channel = await createOrUpdateRealtimeChannel(project.id, {
        topic: body.topic,
        isPrivate: body.isPrivate,
        config: body.config,
      });
      return reply.code(201).send({ channel });
    }
  );

  // Broadcast Message via HTTP API
  app.post(
    "/v1/projects/:projectRef/realtime/broadcast",
    async (request, reply) => {
      const { projectRef } = request.params as { projectRef: string };
      const { project, auth } = await resolveProjectServiceAuth(
        request,
        projectRef,
        { requiredScope: "realtime:subscribe" }
      );
      const body = (request.body ?? {}) as {
        topic?: string;
        event?: string;
        payload?: Record<string, unknown>;
      };
      if (!body.topic) {
        throw new ValidationError("Broadcast 'topic' is required.");
      }
      const eventRecord = await realtimeBroker.publishBroadcast(project.id, {
        topic: body.topic,
        event: body.event ?? "message",
        payload: body.payload ?? {},
        senderId: auth.userId ?? null,
      });
      return reply.code(201).send({ event: eventRecord });
    }
  );

  // Recent Realtime Event Log
  app.get("/v1/projects/:projectRef/realtime/events", async (request) => {
    const { projectRef } = request.params as { projectRef: string };
    const { project } = await resolveProjectServiceAuth(request, projectRef, {
      requiredScope: "realtime:subscribe",
    });
    const q = (request.query ?? {}) as {
      topic?: string;
      limit?: string;
      sinceId?: string;
    };
    const events = await listRecentRealtimeEvents(project.id, {
      topic: q.topic,
      limit: q.limit ? Number(q.limit) : 50,
      sinceId: q.sinceId ? Number(q.sinceId) : undefined,
    });
    return { events };
  });
}
