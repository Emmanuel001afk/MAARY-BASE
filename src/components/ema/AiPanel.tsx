import { useState } from "react";
import { Send, Square, Sparkles } from "lucide-react";
import type { ChatBubble } from "@/lib/use-ema";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export function AiPanel({
  chat,
  thinking,
  onAsk,
  onStop,
}: {
  chat: ChatBubble[];
  thinking: boolean;
  onAsk: (prompt: string) => void;
  onStop: () => void;
}) {
  const [value, setValue] = useState("");

  function submit() {
    const prompt = value.trim();
    if (!prompt || thinking) return;
    setValue("");
    onAsk(prompt);
  }

  return (
    <section className="panel flex min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Sparkles className="size-4 text-primary" />
        <h2 className="font-display text-sm">Ask EMA</h2>
        {thinking && (
          <span className="ml-auto animate-pulse text-xs text-primary">working…</span>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-2 p-3">
          {chat.length === 0 && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Tell EMA what to do — “open YouTube and find the newest video from X”, “log into
              GitHub and summarise my notifications”, “close tab 2 and open my bank”. It reads
              pages, fills forms, uses your vault, and asks before anything irreversible.
            </p>
          )}
          {chat.map((bubble, i) => (
            <div
              key={i}
              className={cn(
                "rounded-md px-3 py-2 text-xs leading-relaxed",
                bubble.role === "user" && "bg-primary/15 text-foreground",
                bubble.role === "assistant" && "bg-secondary text-secondary-foreground",
                bubble.role === "tool" && "bg-muted/60 font-mono text-[11px] text-muted-foreground",
              )}
            >
              {bubble.text}
            </div>
          ))}
        </div>
      </ScrollArea>

      <div className="border-t border-border p-2">
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={3}
          placeholder="What should EMA do?"
          className="resize-none text-xs"
        />
        <div className="mt-2 flex gap-2">
          <Button size="sm" className="flex-1" onClick={submit} disabled={thinking}>
            <Send className="size-3.5" /> Send
          </Button>
          {thinking && (
            <Button size="sm" variant="secondary" onClick={onStop}>
              <Square className="size-3.5" /> Stop
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
