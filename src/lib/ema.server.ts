import { decryptSecret } from "./crypto.server";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};

export async function callOpenAICompatible(args: {
  baseUrl: string;
  model: string;
  keyEncrypted: string;
  messages: ChatMessage[];
  tools: unknown[];
}) {
  const apiKey = await decryptSecret(args.keyEncrypted);
  const base = args.baseUrl.replace(/\/+$/, "");
  // No client-side timeout: model calls can legitimately run for minutes.
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: args.model,
      messages: args.messages,
      tools: args.tools,
      tool_choice: "auto",
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`AI provider error ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text) as { choices?: { message?: ChatMessage }[] };
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error("AI provider returned no message");
  return {
    role: "assistant" as const,
    content: message.content ?? null,
    tool_calls: message.tool_calls ?? [],
  };
}
