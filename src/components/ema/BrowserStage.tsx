import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  X,
  Loader2,
} from "lucide-react";
import type { Frame, TabInfo } from "@/lib/agent-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = {
  tabs: TabInfo[];
  activeTabId: string | null;
  frame: Frame | null;
  viewport: "desktop" | "mobile";
  connected: boolean;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
  onActivateTab: (id: string) => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onReload: () => void;
  onViewport: (v: "desktop" | "mobile") => void;
  onClickAt: (x: number, y: number) => void;
  onKeys: (text: string, key?: string) => void;
  onScroll: (dy: number) => void;
};

export function BrowserStage(props: Props) {
  const [address, setAddress] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const size = props.viewport === "mobile" ? { w: 390, h: 844 } : { w: 1280, h: 800 };

  useEffect(() => {
    if (props.frame?.url && props.frame.url !== "about:blank") setAddress(props.frame.url);
  }, [props.frame?.url]);

  function handleClick(event: React.MouseEvent<HTMLImageElement>) {
    const el = imgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * size.w;
    const y = ((event.clientY - rect.top) / rect.height) * size.h;
    props.onClickAt(x, y);
    el.focus();
  }

  function handleKey(event: React.KeyboardEvent<HTMLImageElement>) {
    event.preventDefault();
    const named = ["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    if (named.includes(event.key)) props.onKeys("", event.key);
    else if (event.key.length === 1) props.onKeys(event.key);
  }

  return (
    <section className="panel flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
        {props.tabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              "group flex max-w-52 shrink-0 items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors",
              tab.id === props.activeTabId
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/50",
            )}
          >
            <button className="truncate" onClick={() => props.onActivateTab(tab.id)}>
              {tab.title || tab.url || "New tab"}
            </button>
            <button
              aria-label="Close tab"
              onClick={() => props.onCloseTab(tab.id)}
              className="opacity-50 transition-opacity hover:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={props.onNewTab}>
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="flex items-center gap-2 border-b border-border px-2 py-2">
        <Button size="icon" variant="ghost" className="size-8" onClick={props.onBack}>
          <ArrowLeft className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" className="size-8" onClick={props.onReload}>
          <RotateCw className="size-4" />
        </Button>
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            props.onNavigate(address);
          }}
        >
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Type a URL or search…"
            className="h-8 font-mono text-xs"
          />
        </form>
        <div className="flex items-center rounded-md border border-border p-0.5">
          <Button
            size="icon"
            variant={props.viewport === "desktop" ? "secondary" : "ghost"}
            className="size-7"
            onClick={() => props.onViewport("desktop")}
          >
            <Monitor className="size-4" />
          </Button>
          <Button
            size="icon"
            variant={props.viewport === "mobile" ? "secondary" : "ghost"}
            className="size-7"
            onClick={() => props.onViewport("mobile")}
          >
            <Smartphone className="size-4" />
          </Button>
        </div>
      </div>

      <div
        className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-background/60 p-3"
        onWheel={(e) => props.onScroll(e.deltaY)}
      >
        {props.frame ? (
          <img
            ref={imgRef}
            tabIndex={0}
            src={`data:image/jpeg;base64,${props.frame.image}`}
            alt={props.frame.title || "Live browser view"}
            onClick={handleClick}
            onKeyDown={handleKey}
            style={{ maxWidth: size.w, aspectRatio: `${size.w} / ${size.h}` }}
            className="w-full rounded-md border border-border outline-none ring-primary/60 focus:ring-2"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            {props.connected ? (
              <>
                <Loader2 className="size-5 animate-spin" />
                Open a tab to start browsing.
              </>
            ) : (
              <>
                <p className="font-display text-base text-foreground">Browser agent offline</p>
                <p className="max-w-sm">
                  Start the agent on your machine (see <code className="font-mono">agent/README.md</code>
                  ), then set its address in Settings and reconnect.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
