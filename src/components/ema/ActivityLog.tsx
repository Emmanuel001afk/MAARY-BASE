import { History } from "lucide-react";
import type { LogRow } from "@/lib/use-ema";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export function ActivityLog({ log }: { log: LogRow[] }) {
  return (
    <section className="panel flex min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <History className="size-4 text-accent" />
        <h2 className="font-display text-sm">Activity</h2>
        <span className="ml-auto text-xs text-muted-foreground">{log.length}</span>
      </header>
      <ScrollArea className="min-h-0 flex-1">
        <ul className="divide-y divide-border/60">
          {log.map((row) => (
            <li key={row.id} className="px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                    row.actor === "ai" && "bg-primary/20 text-primary",
                    row.actor === "user" && "bg-accent/20 text-accent",
                    row.actor === "system" && "bg-muted text-muted-foreground",
                  )}
                >
                  {row.actor}
                </span>
                <time className="font-mono text-[10px] text-muted-foreground">
                  {new Date(row.created_at).toLocaleTimeString()}
                </time>
                {row.status !== "ok" && (
                  <span className="text-[10px] text-destructive">{row.status}</span>
                )}
              </div>
              <p className="mt-1 break-words text-muted-foreground">{row.action}</p>
            </li>
          ))}
          {log.length === 0 && (
            <li className="px-3 py-4 text-xs text-muted-foreground">Nothing logged yet.</li>
          )}
        </ul>
      </ScrollArea>
    </section>
  );
}
