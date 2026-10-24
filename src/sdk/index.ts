import WebSocket from "ws";

export interface MaaryClientOptions {
  projectRef: string;
  accessToken?: string;
  fetch?: typeof globalThis.fetch;
}

export interface MaaryResponse<T = any> {
  data: T | null;
  error: { code: string; message: string; status: number } | null;
  count?: number;
  status: number;
}

class MaaryQueryBuilder<T = Record<string, any>>
  implements PromiseLike<MaaryResponse<T>>
{
  private method: "GET" | "POST" | "PATCH" | "DELETE" = "GET";
  private queryParams = new URLSearchParams();
  private bodyPayload: unknown = undefined;
  private customHeaders: Record<string, string> = {};

  constructor(
    private readonly baseUrl: string,
    private readonly projectRef: string,
    private readonly tableName: string,
    private readonly getHeaders: () => Record<string, string>,
    private readonly fetchFn: typeof globalThis.fetch
  ) {}

  select(columns = "*"): this {
    this.queryParams.set("select", columns);
    return this;
  }

  insert(
    values: Record<string, unknown> | Array<Record<string, unknown>>,
    options?: { onConflict?: string; ignoreDuplicates?: boolean; select?: string }
  ): this {
    this.method = "POST";
    this.bodyPayload = values;
    if (options?.onConflict) {
      this.queryParams.set("on_conflict", options.onConflict);
    }
    if (options?.ignoreDuplicates) {
      this.customHeaders["Prefer"] = "resolution=ignore-duplicates";
    }
    if (options?.select) {
      this.queryParams.set("select", options.select);
    }
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.method = "PATCH";
    this.bodyPayload = values;
    return this;
  }

  delete(): this {
    this.method = "DELETE";
    return this;
  }

  eq(column: string, value: string | number | boolean): this {
    this.queryParams.append(column, `eq.${value}`);
    return this;
  }

  neq(column: string, value: string | number | boolean): this {
    this.queryParams.append(column, `neq.${value}`);
    return this;
  }

  gt(column: string, value: string | number): this {
    this.queryParams.append(column, `gt.${value}`);
    return this;
  }

  gte(column: string, value: string | number): this {
    this.queryParams.append(column, `gte.${value}`);
    return this;
  }

  lt(column: string, value: string | number): this {
    this.queryParams.append(column, `lt.${value}`);
    return this;
  }

  lte(column: string, value: string | number): this {
    this.queryParams.append(column, `lte.${value}`);
    return this;
  }

  like(column: string, pattern: string): this {
    this.queryParams.append(column, `like.${pattern}`);
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.queryParams.append(column, `ilike.${pattern}`);
    return this;
  }

  in(column: string, values: Array<string | number>): this {
    this.queryParams.append(column, `in.(${values.join(",")})`);
    return this;
  }

  is(column: string, value: null | boolean | "null" | "not.null"): this {
    this.queryParams.append(column, `is.${String(value)}`);
    return this;
  }

  or(expression: string): this {
    this.queryParams.set("or", `(${expression.replace(/^\(|\)$/g, "")})`);
    return this;
  }

  order(
    column: string,
    options: { ascending?: boolean; nullsFirst?: boolean } = {}
  ): this {
    const dir = options.ascending === false ? "desc" : "asc";
    const existing = this.queryParams.get("order");
    const next = `${column}.${dir}`;
    this.queryParams.set("order", existing ? `${existing},${next}` : next);
    return this;
  }

  limit(count: number): this {
    this.queryParams.set("limit", String(count));
    return this;
  }

  offset(count: number): this {
    this.queryParams.set("offset", String(count));
    return this;
  }

  single(): this {
    this.queryParams.set("single", "true");
    return this;
  }

  count(mode: "exact" = "exact"): this {
    this.queryParams.set("count", mode);
    return this;
  }

  async execute(): Promise<MaaryResponse<T>> {
    const qs = this.queryParams.toString();
    const url = `${this.baseUrl}/v1/projects/${encodeURIComponent(this.projectRef)}/rest/${encodeURIComponent(this.tableName)}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = {
      ...this.getHeaders(),
      ...this.customHeaders,
    };
    if (this.bodyPayload !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const res = await this.fetchFn(url, {
      method: this.method,
      headers,
      body:
        this.bodyPayload !== undefined
          ? JSON.stringify(this.bodyPayload)
          : undefined,
    });
    const json = (await res.json()) as any;
    if (!res.ok) {
      return {
        data: null,
        error: {
          code: json?.error ?? "request_error",
          message: json?.message ?? `HTTP ${res.status}`,
          status: res.status,
        },
        status: res.status,
      };
    }
    return {
      data: (json.data ?? json) as T,
      count: json.count,
      error: null,
      status: res.status,
    };
  }

  then<TResult1 = MaaryResponse<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: MaaryResponse<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: any) => TResult2 | PromiseLike<TResult2>)
      | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export class MaaryRealtimeChannel {
  private ws: WebSocket | null = null;
  private listeners: Array<{
    eventType: string;
    callback: (payload: any) => void;
  }> = [];

  constructor(
    private readonly baseUrl: string,
    private readonly projectRef: string,
    private readonly apiKey: string,
    private readonly getAccessToken: () => string | undefined,
    private readonly topic: string,
    private readonly options: {
      table?: string;
      event?: "INSERT" | "UPDATE" | "DELETE" | "*";
      filter?: { column: string; value: string | number | boolean };
      lastEventId?: number;
    } = {}
  ) {}

  on(
    eventType: "postgres_changes" | "broadcast" | "presence_state" | "*",
    callback: (payload: any) => void
  ): this {
    this.listeners.push({ eventType, callback });
    return this;
  }

  async subscribe(): Promise<this> {
    const wsBase = this.baseUrl.replace(/^http/, "ws");
    const token = this.getAccessToken();
    const qs = new URLSearchParams({ apikey: this.apiKey });
    const url = `${wsBase}/v1/projects/${encodeURIComponent(this.projectRef)}/realtime/ws?${qs.toString()}`;

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const ws = new WebSocket(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      this.ws = ws;

      const onInitialMessage = (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "connected") {
            ws.send(
              JSON.stringify({
                type: "subscribe",
                topic: this.topic,
                table: this.options.table,
                event: this.options.event ?? "*",
                filter: this.options.filter,
                lastEventId: this.options.lastEventId,
              })
            );
          } else if (msg.type === "subscribed" && msg.topic === this.topic) {
            ws.off("message", onInitialMessage);
            resolvePromise();
          } else if (msg.type === "error") {
            ws.off("message", onInitialMessage);
            rejectPromise(new Error(msg.message || "Realtime error"));
          }
        } catch {
          // Ignore parse error
        }
      };

      ws.on("message", onInitialMessage);
      ws.on("message", (raw: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(raw.toString());
          for (const listener of this.listeners) {
            if (listener.eventType === "*" || listener.eventType === msg.type) {
              listener.callback(msg);
            }
          }
        } catch {
          // Ignore malformed frame
        }
      });
      ws.once("error", (err) => rejectPromise(err));
    });

    return this;
  }

  broadcast(event: string, payload: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "broadcast",
          topic: this.topic,
          event,
          payload,
        })
      );
    }
  }

  unsubscribe(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close error
      }
      this.ws = null;
    }
  }
}

export function createMaaryClient(
  baseUrl: string,
  apiKey: string,
  options: MaaryClientOptions
) {
  const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
  const projectRef = options.projectRef;
  const fetchFn = options.fetch ?? globalThis.fetch;
  let accessToken = options.accessToken;
  let refreshToken: string | undefined;

  const getHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      apikey: apiKey,
    };
    if (accessToken) {
      h["Authorization"] = `Bearer ${accessToken}`;
    }
    return h;
  };

  return {
    setAccessToken(token: string | undefined) {
      accessToken = token;
    },
    getAccessToken() {
      return accessToken;
    },

    from<T = Record<string, any>>(tableName: string) {
      return new MaaryQueryBuilder<T>(
        cleanBaseUrl,
        projectRef,
        tableName,
        getHeaders,
        fetchFn
      );
    },

    async rpc<T = any>(
      fnName: string,
      args: Record<string, unknown> = {}
    ): Promise<MaaryResponse<T>> {
      const res = await fetchFn(
        `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/rpc/${encodeURIComponent(fnName)}`,
        {
          method: "POST",
          headers: {
            ...getHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
        }
      );
      const json = (await res.json()) as any;
      if (!res.ok) {
        return {
          data: null,
          error: {
            code: json?.error ?? "rpc_error",
            message: json?.message ?? `HTTP ${res.status}`,
            status: res.status,
          },
          status: res.status,
        };
      }
      return { data: json.data as T, error: null, status: res.status };
    },

    auth: {
      async signUp(input: {
        email: string;
        password: string;
        phone?: string;
        data?: Record<string, unknown>;
      }) {
        const res = await fetchFn(
          `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/auth/signup`,
          {
            method: "POST",
            headers: {
              ...getHeaders(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(input),
          }
        );
        const json = (await res.json()) as any;
        if (res.ok && json.session?.access_token) {
          accessToken = json.session.access_token;
          refreshToken = json.session.refresh_token;
        }
        return {
          data: res.ok ? json : null,
          error: res.ok
            ? null
            : {
                code: json.error,
                message: json.message,
                status: res.status,
              },
        };
      },

      async signInWithPassword(input: { email: string; password: string }) {
        const res = await fetchFn(
          `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/auth/login`,
          {
            method: "POST",
            headers: {
              ...getHeaders(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify(input),
          }
        );
        const json = (await res.json()) as any;
        if (res.ok && json.access_token) {
          accessToken = json.access_token;
          refreshToken = json.refresh_token;
        }
        return {
          data: res.ok ? json : null,
          error: res.ok
            ? null
            : {
                code: json.error,
                message: json.message,
                status: res.status,
              },
        };
      },

      async refreshSession(tokenToUse?: string) {
        const rt = tokenToUse ?? refreshToken;
        const res = await fetchFn(
          `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/auth/refresh`,
          {
            method: "POST",
            headers: {
              ...getHeaders(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ refresh_token: rt }),
          }
        );
        const json = (await res.json()) as any;
        if (res.ok && json.access_token) {
          accessToken = json.access_token;
          refreshToken = json.refresh_token;
        }
        return {
          data: res.ok ? json : null,
          error: res.ok
            ? null
            : {
                code: json.error,
                message: json.message,
                status: res.status,
              },
        };
      },

      async getUser() {
        const res = await fetchFn(
          `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/auth/user`,
          {
            method: "GET",
            headers: getHeaders(),
          }
        );
        const json = (await res.json()) as any;
        return {
          data: res.ok ? json.user : null,
          error: res.ok
            ? null
            : {
                code: json.error,
                message: json.message,
                status: res.status,
              },
        };
      },

      async signOut() {
        const res = await fetchFn(
          `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/auth/logout`,
          {
            method: "POST",
            headers: getHeaders(),
          }
        );
        accessToken = undefined;
        refreshToken = undefined;
        return { ok: res.ok };
      },
    },

    storage: {
      from(bucketName: string) {
        return {
          async upload(
            path: string,
            content: string | Buffer,
            opts: {
              mimeType?: string;
              metadata?: Record<string, unknown>;
              upsert?: boolean;
            } = {}
          ) {
            const payload = Buffer.isBuffer(content)
              ? {
                  contentBase64: content.toString("base64"),
                  mimeType: opts.mimeType ?? "application/octet-stream",
                  metadata: opts.metadata,
                  upsert: opts.upsert ?? true,
                }
              : {
                  content,
                  mimeType: opts.mimeType ?? "text/plain",
                  metadata: opts.metadata,
                  upsert: opts.upsert ?? true,
                };
            const res = await fetchFn(
              `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/storage/buckets/${encodeURIComponent(bucketName)}/objects/${path.replace(/^\/+/, "")}`,
              {
                method: "POST",
                headers: {
                  ...getHeaders(),
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
              }
            );
            const json = (await res.json()) as any;
            return {
              data: res.ok ? json.object : null,
              error: res.ok
                ? null
                : {
                    code: json.error,
                    message: json.message,
                    status: res.status,
                  },
            };
          },

          async download(path: string) {
            const res = await fetchFn(
              `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/storage/buckets/${encodeURIComponent(bucketName)}/objects/${path.replace(/^\/+/, "")}`,
              {
                method: "GET",
                headers: getHeaders(),
              }
            );
            if (!res.ok) {
              const json = (await res.json().catch(() => ({}))) as any;
              return {
                data: null,
                error: {
                  code: json.error ?? "storage_error",
                  message: json.message ?? `HTTP ${res.status}`,
                  status: res.status,
                },
              };
            }
            const ab = await res.arrayBuffer();
            return { data: Buffer.from(ab), error: null };
          },

          async list(opts: { prefix?: string; limit?: number } = {}) {
            const qs = new URLSearchParams();
            if (opts.prefix) qs.set("prefix", opts.prefix);
            if (opts.limit) qs.set("limit", String(opts.limit));
            const res = await fetchFn(
              `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/storage/buckets/${encodeURIComponent(bucketName)}/objects?${qs.toString()}`,
              {
                method: "GET",
                headers: getHeaders(),
              }
            );
            const json = (await res.json()) as any;
            return {
              data: res.ok ? json.objects : null,
              error: res.ok
                ? null
                : {
                    code: json.error,
                    message: json.message,
                    status: res.status,
                  },
            };
          },

          async remove(path: string) {
            const res = await fetchFn(
              `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/storage/buckets/${encodeURIComponent(bucketName)}/objects/${path.replace(/^\/+/, "")}`,
              {
                method: "DELETE",
                headers: getHeaders(),
              }
            );
            const json = (await res.json()) as any;
            return {
              data: res.ok ? json.object : null,
              error: res.ok
                ? null
                : {
                    code: json.error,
                    message: json.message,
                    status: res.status,
                  },
            };
          },

          async createSignedUrl(
            path: string,
            expiresIn = 3600,
            operation: "download" | "upload" = "download"
          ) {
            const res = await fetchFn(
              `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/storage/buckets/${encodeURIComponent(bucketName)}/sign/${path.replace(/^\/+/, "")}`,
              {
                method: "POST",
                headers: {
                  ...getHeaders(),
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ expiresIn, operation }),
              }
            );
            const json = (await res.json()) as any;
            return {
              data: res.ok
                ? {
                    ...json,
                    fullSignedUrl: `${cleanBaseUrl}${json.signedUrl}`,
                  }
                : null,
              error: res.ok
                ? null
                : {
                    code: json.error,
                    message: json.message,
                    status: res.status,
                  },
            };
          },
        };
      },
    },

    functions: {
      async invoke(
        slug: string,
        opts: {
          method?: string;
          body?: unknown;
          headers?: Record<string, string>;
        } = {}
      ) {
        const res = await fetchFn(
          `${cleanBaseUrl}/v1/projects/${encodeURIComponent(projectRef)}/functions/${encodeURIComponent(slug)}/invoke`,
          {
            method: opts.method ?? "POST",
            headers: {
              ...getHeaders(),
              "Content-Type": "application/json",
              ...(opts.headers ?? {}),
            },
            body:
              opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          }
        );
        const json = (await res.json()) as any;
        return {
          data: res.ok ? json.data : null,
          logs: json.logs ?? [],
          invocationId: json.invocationId,
          error: res.ok
            ? null
            : {
                code: json.error ?? "function_error",
                message: json.message ?? json.error ?? `HTTP ${res.status}`,
                status: res.status,
              },
        };
      },
    },

    realtime: {
      channel(
        topic: string,
        channelOptions?: {
          table?: string;
          event?: "INSERT" | "UPDATE" | "DELETE" | "*";
          filter?: { column: string; value: string | number | boolean };
          lastEventId?: number;
        }
      ) {
        return new MaaryRealtimeChannel(
          cleanBaseUrl,
          projectRef,
          apiKey,
          () => accessToken,
          topic,
          channelOptions
        );
      },
    },
  };
}

export const createMarryBaseClient = createMaaryClient;


