export type TabInfo = {
  id: string;
  title: string;
  url: string;
  viewport: "desktop" | "mobile";
  active: boolean;
};

export type Frame = { tabId: string; url: string; title: string; image: string };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export type AgentStatus = "idle" | "connecting" | "connected" | "error";

export class AgentClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private counter = 0;

  onFrame: ((frame: Frame) => void) | null = null;
  onStatus: ((status: AgentStatus, message?: string) => void) | null = null;

  connect(url: string, token: string) {
    this.disconnect();
    const target = token ? `${url}?token=${encodeURIComponent(token)}` : url;
    this.onStatus?.("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(target);
    } catch {
      this.onStatus?.("error", "Invalid agent URL");
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.onStatus?.("connected");
    ws.onerror = () => this.onStatus?.("error", "Could not reach the browser agent");
    ws.onclose = () => this.onStatus?.("idle");
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (msg["type"] === "frame") {
        this.onFrame?.(msg as unknown as Frame);
        return;
      }
      const id = String(msg["id"] ?? "");
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (msg["ok"]) entry.resolve(msg["result"]);
      else entry.reject(new Error(String(msg["error"] ?? "Agent error")));
    };
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this.pending.clear();
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Browser agent is not connected"));
        return;
      }
      const id = `r${++this.counter}`;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 120000);
    });
  }
}
