import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { pool } from "../db/pool.js";
import {
  ForbiddenError,
  QuotaExceededError,
  ValidationError,
} from "../lib/errors.js";
import { incrementProjectMetric } from "./audit.service.js";
import type { DataAuthContext } from "./data-api.service.js";
import type { ProjectRecord } from "./project.service.js";

export interface RealtimeSubscription {
  topic: string;
  table?: string;
  event?: "INSERT" | "UPDATE" | "DELETE" | "*";
  filter?: {
    column: string;
    value: string | number | boolean;
  };
}

export interface ConnectedRealtimeClient {
  id: string;
  projectId: string;
  projectSlug: string;
  socket: WebSocket;
  auth: DataAuthContext;
  scopes: string[];
  subscriptions: Map<string, RealtimeSubscription>;
  presenceKey?: string;
  presenceMeta?: Record<string, unknown>;
  connectedAt: string;
}

export interface RealtimeEventRow {
  id: string;
  project_id: string;
  channel_topic: string;
  event_type: "postgres_changes" | "broadcast" | "presence";
  schema_name: string | null;
  table_name: string | null;
  operation: string | null;
  record: Record<string, unknown> | null;
  old_record: Record<string, unknown> | null;
  payload: Record<string, unknown>;
  created_at: string;
}

class RealtimeBroker {
  private clients = new Map<string, ConnectedRealtimeClient>();
  private lastDispatchedId = 0;
  private initializedCursor = false;
  private flushing = false;
  private pollTimer: NodeJS.Timeout | null = null;

  startPolling(intervalMs = 150): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (this.clients.size > 0) {
        void this.flushDatabaseEvents();
      }
    }, intervalMs);
    this.pollTimer.unref();
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async ensureCursorInitialized(): Promise<void> {
    if (this.initializedCursor) return;
    try {
      const res = await pool.query<{ max_id: string | null }>(
        `SELECT MAX(id)::text AS max_id FROM platform_realtime_events`
      );
      this.lastDispatchedId = Number(res.rows[0]?.max_id ?? 0);
      this.initializedCursor = true;
    } catch {
      this.lastDispatchedId = 0;
    }
  }

  async registerClient(
    project: ProjectRecord,
    socket: WebSocket,
    auth: DataAuthContext,
    scopes: string[]
  ): Promise<ConnectedRealtimeClient> {
    await this.ensureCursorInitialized();
    this.startPolling();

    const projectClients = Array.from(this.clients.values()).filter(
      (c) => c.projectId === project.id
    );
    const maxConns = project.quotas?.maxRealtimeConnections ?? 100;
    if (projectClients.length >= maxConns) {
      throw new QuotaExceededError(
        `Project realtime connection limit (${maxConns}) exceeded.`
      );
    }

    const client: ConnectedRealtimeClient = {
      id: randomUUID(),
      projectId: project.id,
      projectSlug: project.slug,
      socket,
      auth,
      scopes,
      subscriptions: new Map(),
      connectedAt: new Date().toISOString(),
    };

    this.clients.set(client.id, client);
    socket.on("close", () => {
      this.removeClient(client.id);
    });
    socket.on("error", () => {
      this.removeClient(client.id);
    });

    this.sendToClient(client, {
      type: "connected",
      clientId: client.id,
      projectSlug: project.slug,
      role: auth.role,
      deliveryGuarantee: "at-least-once-within-retention-window",
      timestamp: new Date().toISOString(),
    });

    return client;
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    this.clients.delete(clientId);
  }

  private sendToClient(
    client: ConnectedRealtimeClient,
    message: Record<string, unknown>
  ): void {
    try {
      if (client.socket.readyState === 1) {
        client.socket.send(JSON.stringify(message));
      }
    } catch {
      // Ignore send errors on closing socket
    }
  }

  async handleClientMessage(
    client: ConnectedRealtimeClient,
    rawMessage: string
  ): Promise<void> {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(rawMessage);
    } catch {
      this.sendToClient(client, {
        type: "error",
        code: "invalid_json",
        message: "Realtime message must be valid JSON.",
      });
      return;
    }

    const type = String(msg.type || "");

    if (type === "ping" || type === "heartbeat") {
      this.sendToClient(client, {
        type: "pong",
        ref: msg.ref ?? null,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (type === "subscribe") {
      const topic = String(msg.topic || "").trim();
      if (!topic) {
        this.sendToClient(client, {
          type: "error",
          code: "validation_error",
          message: "Subscription requires a 'topic'.",
        });
        return;
      }

      if (
        !client.scopes.includes("*") &&
        !client.scopes.includes("realtime:subscribe")
      ) {
        this.sendToClient(client, {
          type: "error",
          code: "forbidden",
          message: "Credentials lack 'realtime:subscribe' scope.",
        });
        return;
      }

      // Check if channel is marked private
      const chanRes = await pool.query<{ is_private: boolean }>(
        `SELECT is_private FROM platform_realtime_channels WHERE project_id = $1 AND topic = $2`,
        [client.projectId, topic]
      );
      if (
        chanRes.rows[0]?.is_private &&
        client.auth.role === "anon"
      ) {
        this.sendToClient(client, {
          type: "error",
          code: "forbidden",
          topic,
          message: `Channel '${topic}' is private and requires authenticated access.`,
        });
        return;
      }

      const sub: RealtimeSubscription = {
        topic,
        table:
          typeof msg.table === "string"
            ? msg.table
            : topic.startsWith("db:")
              ? topic.slice(3)
              : undefined,
        event: msg.event ?? "*",
        filter:
          msg.filter &&
          typeof msg.filter === "object" &&
          typeof msg.filter.column === "string"
            ? {
                column: msg.filter.column,
                value: msg.filter.value,
              }
            : undefined,
      };

      client.subscriptions.set(topic, sub);
      this.sendToClient(client, {
        type: "subscribed",
        topic,
        ref: msg.ref ?? null,
        timestamp: new Date().toISOString(),
      });

      // Replay missed events if lastEventId was supplied
      if (
        typeof msg.lastEventId === "number" &&
        Number.isInteger(msg.lastEventId) &&
        msg.lastEventId >= 0
      ) {
        const missedRes = await pool.query<RealtimeEventRow>(
          `SELECT * FROM platform_realtime_events
           WHERE project_id = $1 AND id > $2
           ORDER BY id ASC
           LIMIT 100`,
          [client.projectId, msg.lastEventId]
        );
        for (const ev of missedRes.rows) {
          if (this.doesEventMatchSubscription(ev, sub)) {
            this.sendToClient(client, this.formatOutgoingEvent(ev));
          }
        }
      }
      return;
    }

    if (type === "unsubscribe") {
      const topic = String(msg.topic || "").trim();
      client.subscriptions.delete(topic);
      this.sendToClient(client, {
        type: "unsubscribed",
        topic,
        ref: msg.ref ?? null,
      });
      return;
    }

    if (type === "broadcast") {
      const topic = String(msg.topic || "").trim();
      const eventName = String(msg.event || "message");
      if (!topic) {
        this.sendToClient(client, {
          type: "error",
          code: "validation_error",
          message: "Broadcast requires a 'topic'.",
        });
        return;
      }

      await this.publishBroadcast(client.projectId, {
        topic,
        event: eventName,
        payload:
          msg.payload && typeof msg.payload === "object"
            ? msg.payload
            : { value: msg.payload },
        senderId: client.auth.userId ?? client.id,
      });
      return;
    }

    if (type === "presence_track") {
      const topic = String(msg.topic || "presence:global").trim();
      client.presenceKey = String(msg.key || client.auth.userId || client.id);
      client.presenceMeta =
        msg.payload && typeof msg.payload === "object" ? msg.payload : {};

      const state = this.getChannelPresence(client.projectId, topic);
      for (const peer of this.clients.values()) {
        if (
          peer.projectId === client.projectId &&
          peer.subscriptions.has(topic)
        ) {
          this.sendToClient(peer, {
            type: "presence_state",
            topic,
            presences: state,
            timestamp: new Date().toISOString(),
          });
        }
      }
      return;
    }

    this.sendToClient(client, {
      type: "error",
      code: "unknown_message_type",
      message: `Unsupported realtime message type '${type}'.`,
    });
  }

  getChannelPresence(
    projectId: string,
    topic: string
  ): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const c of this.clients.values()) {
      if (
        c.projectId === projectId &&
        c.subscriptions.has(topic) &&
        c.presenceKey
      ) {
        out[c.presenceKey] = {
          clientId: c.id,
          userId: c.auth.userId ?? null,
          ...(c.presenceMeta ?? {}),
        };
      }
    }
    return out;
  }

  private doesEventMatchSubscription(
    ev: RealtimeEventRow,
    sub: RealtimeSubscription
  ): boolean {
    if (ev.event_type === "postgres_changes") {
      const targetTable = sub.table ?? (sub.topic.startsWith("db:") ? sub.topic.slice(3) : null);
      if (
        sub.topic !== "*" &&
        sub.topic !== "db:*" &&
        targetTable !== "*" &&
        targetTable !== ev.table_name
      ) {
        return false;
      }
      if (
        sub.event &&
        sub.event !== "*" &&
        sub.event.toUpperCase() !== (ev.operation ?? "").toUpperCase()
      ) {
        return false;
      }
      if (sub.filter) {
        const recordToCheck = ev.record ?? ev.old_record ?? {};
        if (String(recordToCheck[sub.filter.column]) !== String(sub.filter.value)) {
          return false;
        }
      }
      return true;
    }

    return sub.topic === "*" || sub.topic === ev.channel_topic;
  }

  private formatOutgoingEvent(ev: RealtimeEventRow): Record<string, unknown> {
    return {
      type: ev.event_type,
      eventId: Number(ev.id),
      topic: ev.channel_topic,
      schema: ev.schema_name,
      table: ev.table_name,
      operation: ev.operation,
      record: ev.record,
      old_record: ev.old_record,
      payload: ev.payload,
      timestamp: ev.created_at,
    };
  }

  async flushDatabaseEvents(): Promise<number> {
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      await this.ensureCursorInitialized();
      const res = await pool.query<RealtimeEventRow>(
        `SELECT * FROM platform_realtime_events
         WHERE id > $1
         ORDER BY id ASC
         LIMIT 200`,
        [this.lastDispatchedId]
      );

      for (const ev of res.rows) {
        const numId = Number(ev.id);
        if (numId > this.lastDispatchedId) {
          this.lastDispatchedId = numId;
        }
        for (const client of this.clients.values()) {
          if (client.projectId !== ev.project_id) continue;
          for (const sub of client.subscriptions.values()) {
            if (this.doesEventMatchSubscription(ev, sub)) {
              this.sendToClient(client, this.formatOutgoingEvent(ev));
              break;
            }
          }
        }
      }
      return res.rows.length;
    } catch {
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  async publishBroadcast(
    projectId: string,
    input: {
      topic: string;
      event: string;
      payload: Record<string, unknown>;
      senderId?: string | null;
    }
  ): Promise<RealtimeEventRow> {
    await this.ensureCursorInitialized();
    const res = await pool.query<RealtimeEventRow>(
      `INSERT INTO platform_realtime_events (
        project_id, channel_topic, event_type, payload
      ) VALUES ($1, $2, 'broadcast', $3::jsonb)
      RETURNING *`,
      [
        projectId,
        input.topic,
        JSON.stringify({
          event: input.event,
          senderId: input.senderId ?? null,
          data: input.payload,
        }),
      ]
    );
    await incrementProjectMetric(projectId, "realtime_broadcasts_total", 1);
    await this.flushDatabaseEvents();
    return res.rows[0]!;
  }

  getStats(projectId?: string): {
    connectedClients: number;
    subscriptions: number;
    clients: Array<{
      id: string;
      projectId: string;
      role: string;
      topics: string[];
      connectedAt: string;
    }>;
  } {
    const matching = Array.from(this.clients.values()).filter(
      (c) => !projectId || c.projectId === projectId
    );
    let subCount = 0;
    const clientSummaries = matching.map((c) => {
      const topics = Array.from(c.subscriptions.keys());
      subCount += topics.length;
      return {
        id: c.id,
        projectId: c.projectId,
        role: c.auth.role,
        topics,
        connectedAt: c.connectedAt,
      };
    });
    return {
      connectedClients: matching.length,
      subscriptions: subCount,
      clients: clientSummaries,
    };
  }
}

export const realtimeBroker = new RealtimeBroker();

export async function createOrUpdateRealtimeChannel(
  projectId: string,
  input: {
    topic: string;
    isPrivate?: boolean;
    config?: Record<string, unknown>;
  }
): Promise<{
  id: string;
  project_id: string;
  topic: string;
  is_private: boolean;
  config: Record<string, unknown>;
  created_at: string;
}> {
  const topic = input.topic.trim();
  if (!topic) {
    throw new ValidationError("Channel topic is required.");
  }
  const res = await pool.query<{
    id: string;
    project_id: string;
    topic: string;
    is_private: boolean;
    config: Record<string, unknown>;
    created_at: string;
  }>(
    `INSERT INTO platform_realtime_channels (project_id, topic, is_private, config)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (project_id, topic)
     DO UPDATE SET is_private = EXCLUDED.is_private, config = EXCLUDED.config
     RETURNING *`,
    [
      projectId,
      topic,
      Boolean(input.isPrivate),
      JSON.stringify(input.config ?? {}),
    ]
  );
  return res.rows[0]!;
}

export async function listRealtimeChannels(projectId: string) {
  const res = await pool.query(
    `SELECT * FROM platform_realtime_channels WHERE project_id = $1 ORDER BY created_at ASC`,
    [projectId]
  );
  return res.rows;
}

export async function listRecentRealtimeEvents(
  projectId: string,
  options: { topic?: string; limit?: number; sinceId?: number } = {}
): Promise<RealtimeEventRow[]> {
  const params: unknown[] = [projectId];
  const clauses: string[] = ["project_id = $1"];
  if (options.topic) {
    params.push(options.topic);
    clauses.push(`channel_topic = $${params.length}`);
  }
  if (options.sinceId !== undefined) {
    params.push(options.sinceId);
    clauses.push(`id > $${params.length}`);
  }
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  params.push(limit);

  const res = await pool.query<RealtimeEventRow>(
    `SELECT * FROM platform_realtime_events
     WHERE ${clauses.join(" AND ")}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params
  );
  return res.rows;
}
