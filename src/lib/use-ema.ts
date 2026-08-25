import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AgentClient, type AgentStatus, type Frame, type TabInfo } from "./agent-client";
import { AI_TOOLS, systemPrompt } from "./ai-tools";
import { aiChat, getSettings, revealCredential } from "./ema.functions";

export type LogRow = {
  id: string;
  actor: string;
  action: string;
  url: string | null;
  status: string;
  details: Record<string, unknown>;
  created_at: string;
};

export type ChatBubble = { role: "user" | "assistant" | "tool"; text: string };

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ApiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type PendingApproval = {
  summary: string;
  details: string;
  resolve: (approved: boolean) => void;
};

export function useEma(userId: string) {
  const clientRef = useRef<AgentClient | null>(null);
  if (!clientRef.current) clientRef.current = new AgentClient();
  const agent = clientRef.current;

  const [status, setStatus] = useState<AgentStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [viewport, setViewportState] = useState<"desktop" | "mobile">("desktop");
  const [log, setLog] = useState<LogRow[]>([]);
  const [chat, setChat] = useState<ChatBubble[]>([]);
  const [thinking, setThinking] = useState(false);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const historyRef = useRef<ApiMessage[]>([]);
  const stopRef = useRef(false);

  const record = useCallback(
    async (entry: {
      actor: "user" | "ai" | "system";
      action: string;
      url?: string | null;
      status?: string;
      details?: Record<string, unknown>;
    }) => {
      const row = {
        user_id: userId,
        actor: entry.actor,
        action: entry.action,
        url: entry.url ?? null,
        tab_id: activeTabId,
        status: entry.status ?? "ok",
        details: entry.details ?? {},
      };
      const { data } = await supabase.from("activity_log").insert(row).select().single();
      if (data) setLog((prev) => [data as LogRow, ...prev].slice(0, 300));
    },
    [userId, activeTabId],
  );

  const refreshTabs = useCallback(async () => {
    try {
      const list = await agent.call<TabInfo[]>("list_tabs");
      setTabs(list);
      const active = list.find((t) => t.active);
      if (active) {
        setActiveTabId(active.id);
        setViewportState(active.viewport);
      } else if (list.length === 0) {
        setActiveTabId(null);
      }
    } catch {
      /* not connected */
    }
  }, [agent]);

  const connect = useCallback(async () => {
    const settings = await getSettings();
    agent.onFrame = (f) => setFrame(f);
    agent.onStatus = (s, msg) => {
      setStatus(s);
      setStatusMessage(msg ?? "");
      if (s === "connected") {
        void refreshTabs();
        void record({ actor: "system", action: "Connected to browser agent" });
      }
    };
    agent.connect(settings.agent_url, settings.agent_token ?? "");
  }, [agent, refreshTabs, record]);

  useEffect(() => {
    void connect();
    void (async () => {
      const { data } = await supabase
        .from("activity_log")
        .select("id, actor, action, url, status, details, created_at")
        .order("created_at", { ascending: false })
        .limit(200);
      if (data) setLog(data as LogRow[]);
    })();
    return () => agent.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------------- manual browser controls ---------------- */

  const openTab = useCallback(
    async (url = "") => {
      const info = await agent.call<TabInfo>("new_tab", { url, viewport });
      await record({ actor: "user", action: `Opened tab ${url || "blank"}`, url: info?.url });
      await refreshTabs();
    },
    [agent, viewport, record, refreshTabs],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      await agent.call("close_tab", { tabId });
      await record({ actor: "user", action: `Closed tab ${tabId}` });
      await refreshTabs();
    },
    [agent, record, refreshTabs],
  );

  const activateTab = useCallback(
    async (tabId: string) => {
      await agent.call("activate_tab", { tabId });
      setActiveTabId(tabId);
      await refreshTabs();
    },
    [agent, refreshTabs],
  );

  const navigate = useCallback(
    async (url: string) => {
      if (!activeTabId) {
        await openTab(url);
        return;
      }
      await agent.call("navigate", { tabId: activeTabId, url });
      await record({ actor: "user", action: `Navigated to ${url}`, url });
      await refreshTabs();
    },
    [agent, activeTabId, openTab, record, refreshTabs],
  );

  const simple = useCallback(
    async (method: string, params: Record<string, unknown> = {}) => {
      await agent.call(method, { tabId: activeTabId, ...params });
      await refreshTabs();
    },
    [agent, activeTabId, refreshTabs],
  );

  const setViewport = useCallback(
    async (next: "desktop" | "mobile") => {
      setViewportState(next);
      if (activeTabId) await agent.call("set_viewport", { tabId: activeTabId, viewport: next });
      await record({ actor: "user", action: `Switched to ${next} view` });
    },
    [agent, activeTabId, record],
  );

  const clickAt = useCallback(
    async (x: number, y: number) => {
      if (!activeTabId) return;
      await agent.call("click_at", { tabId: activeTabId, x, y });
      await record({ actor: "user", action: `Clicked at ${Math.round(x)},${Math.round(y)}` });
    },
    [agent, activeTabId, record],
  );

  const sendKeys = useCallback(
    async (text: string, key?: string) => {
      if (!activeTabId) return;
      if (key) await agent.call("press_key", { tabId: activeTabId, key });
      else await agent.call("type_text", { tabId: activeTabId, text });
    },
    [agent, activeTabId],
  );

  const scrollBy = useCallback(
    async (dy: number) => {
      if (!activeTabId) return;
      await agent.call("scroll", { tabId: activeTabId, dy });
    },
    [agent, activeTabId],
  );

  /* ---------------- AI driving ---------------- */

  const askApproval = useCallback((summary: string, details: string) => {
    return new Promise<boolean>((resolve) => {
      setApproval({ summary, details, resolve });
    });
  }, []);

  const runTool = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      const withTab = { tabId: activeTabId, ...args };

      if (name === "request_approval") {
        const summary = String(args["summary"] ?? "Irreversible action");
        const details = String(args["details"] ?? "");
        const { data: row } = await supabase
          .from("approvals")
          .insert({ user_id: userId, summary, payload: { details } })
          .select()
          .single();
        const approved = await askApproval(summary, details);
        setApproval(null);
        if (row) {
          await supabase
            .from("approvals")
            .update({ status: approved ? "approved" : "denied", decided_at: new Date().toISOString() })
            .eq("id", row.id);
        }
        await record({
          actor: "ai",
          action: `Approval ${approved ? "granted" : "denied"}: ${summary}`,
          status: approved ? "approved" : "denied",
          details: { details },
        });
        return { approved };
      }

      if (name === "use_credential") {
        const site = String(args["site"] ?? "");
        const cred = await revealCredential({ data: { site, forAi: true } });
        await record({ actor: "ai", action: `Used vault credential for ${cred.site}` });
        return {
          username: cred.username,
          password: cred.secret,
          notes: cred.notes,
          hint: "Fill the login form with type_text using CSS selectors, then submit.",
        };
      }

      if (name === "remember") {
        await supabase.from("ai_memory").insert({
          user_id: userId,
          content: String(args["content"] ?? ""),
          scope: String(args["scope"] ?? "global"),
        });
        return { saved: true };
      }

      if (name === "recall") {
        const { data } = await supabase.from("ai_memory").select("content, scope").limit(50);
        return { memories: data ?? [] };
      }

      if (name === "screenshot") {
        await agent.call("screenshot", withTab);
        return { note: "The owner can see the live view. Use read_page for page content." };
      }

      const result = await agent.call(name, withTab);
      await refreshTabs();
      return result;
    },
    [agent, activeTabId, userId, askApproval, record, refreshTabs],
  );

  const stop = useCallback(() => {
    stopRef.current = true;
    setThinking(false);
  }, []);

  const ask = useCallback(
    async (prompt: string) => {
      stopRef.current = false;
      setChat((c) => [...c, { role: "user", text: prompt }]);
      setThinking(true);
      await record({ actor: "user", action: `Asked EMA: ${prompt}` });

      try {
        const { data: mem } = await supabase.from("ai_memory").select("content").limit(40);
        const tabSummary = tabs.map((t) => `${t.id}: ${t.title || t.url}`).join(" | ");
        const sys: ApiMessage = {
          role: "system",
          content: systemPrompt((mem ?? []).map((m) => m.content), tabSummary),
        };
        historyRef.current = [
          sys,
          ...historyRef.current.filter((m) => m.role !== "system"),
          { role: "user", content: prompt },
        ].slice(-40);

        for (let step = 0; step < 25; step++) {
          if (stopRef.current) break;
          const message = (await aiChat({
            data: { messages: historyRef.current, tools: AI_TOOLS },
          })) as ApiMessage;

          historyRef.current.push({
            role: "assistant",
            content: message.content ?? null,
            tool_calls: message.tool_calls ?? [],
          });
          if (message.content) setChat((c) => [...c, { role: "assistant", text: message.content! }]);

          const calls = message.tool_calls ?? [];
          if (calls.length === 0) break;

          for (const call of calls) {
            if (stopRef.current) break;
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
            } catch {
              args = {};
            }
            setChat((c) => [
              ...c,
              { role: "tool", text: `${call.function.name} ${JSON.stringify(args).slice(0, 160)}` },
            ]);
            let payload: unknown;
            try {
              payload = await runTool(call.function.name, args);
              await record({
                actor: "ai",
                action: `${call.function.name}`,
                details: args,
              });
            } catch (error) {
              payload = { error: error instanceof Error ? error.message : String(error) };
              await record({
                actor: "ai",
                action: `${call.function.name} failed`,
                status: "error",
                details: { ...args, error: String(error) },
              });
            }
            historyRef.current.push({
              role: "tool",
              tool_call_id: call.id,
              content: JSON.stringify(payload).slice(0, 12000),
            });
          }
        }
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        setChat((c) => [...c, { role: "assistant", text: `⚠️ ${text}` }]);
        await record({ actor: "ai", action: "AI run failed", status: "error", details: { text } });
      } finally {
        setThinking(false);
      }
    },
    [tabs, record, runTool],
  );

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId) ?? null, [tabs, activeTabId]);

  return {
    status,
    statusMessage,
    connect,
    tabs,
    activeTab,
    activeTabId,
    frame,
    viewport,
    setViewport,
    openTab,
    closeTab,
    activateTab,
    navigate,
    simple,
    clickAt,
    sendKeys,
    scrollBy,
    log,
    chat,
    thinking,
    ask,
    stop,
    approval,
    setApproval,
  };
}
