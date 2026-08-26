import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { KeyRound, Plug, Settings2, Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useEma } from "@/lib/use-ema";
import { createOwnerAccount } from "@/lib/ema.functions";
import { BrowserStage } from "@/components/ema/BrowserStage";
import { AiPanel } from "@/components/ema/AiPanel";
import { ActivityLog } from "@/components/ema/ActivityLog";
import { VaultDialog } from "@/components/ema/VaultDialog";
import { SettingsDialog } from "@/components/ema/SettingsDialog";
import { ApprovalDialog } from "@/components/ema/ApprovalDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "EMA — AI-driven browser workspace" },
      {
        name: "description",
        content:
          "EMA is a private browser workspace: a live headless Chromium you drive yourself or hand over to an AI, with an encrypted credential vault, approvals and a full activity log.",
      },
      { property: "og:title", content: "EMA — AI-driven browser workspace" },
      {
        property: "og:description",
        content:
          "Drive a live browser yourself or let your AI do it — vault logins, approval gates and a timestamped activity log.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Page,
});

function Page() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Loader2 className="size-5 animate-spin text-primary" />
      </main>
    );
  }

  return session ? <Workspace userId={session.user.id} /> : <OwnerLogin />;
}

function OwnerLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) toast.error(error.message);
  }

  async function bootstrap() {
    setBusy(true);
    try {
      await createOwnerAccount({ data: { email, password } });
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="panel w-full max-w-sm p-6">
        <h1 className="font-display text-2xl">EMA</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Private browser workspace. Owner access only — there is no public sign-up.
        </p>
        <form className="mt-5 space-y-3" onSubmit={signIn}>
          <div className="space-y-1">
            <Label className="text-xs">Email</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Password</Label>
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : "Sign in"}
          </Button>
          <button
            type="button"
            onClick={bootstrap}
            className="w-full text-center text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            First time here? Create the owner account
          </button>
        </form>
      </div>
    </main>
  );
}

function Workspace({ userId }: { userId: string }) {
  const ema = useEma(userId);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const connect = useCallback(() => {
    void ema.connect();
  }, [ema]);

  useEffect(() => {
    void ema.connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="flex h-screen flex-col gap-3 p-3">
      <header className="panel flex items-center gap-3 px-4 py-2.5">
        <h1 className="font-display text-lg tracking-tight">EMA</h1>
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[11px]",
            ema.status === "connected" ? "text-primary" : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              ema.status === "connected" ? "bg-primary" : "bg-muted-foreground",
            )}
          />
          {ema.status === "connected" ? "agent live" : ema.statusMessage || ema.status}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={connect}>
            <Plug className="size-4" /> Reconnect
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setVaultOpen(true)}>
            <KeyRound className="size-4" /> Vault
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="size-4" /> Settings
          </Button>
          <Button size="sm" variant="ghost" onClick={() => supabase.auth.signOut()}>
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1fr_22rem]">
        <BrowserStage
          tabs={ema.tabs}
          activeTabId={ema.activeTabId}
          frame={ema.frame}
          viewport={ema.viewport}
          connected={ema.status === "connected"}
          onNewTab={() => void ema.openTab("")}
          onCloseTab={(id) => void ema.closeTab(id)}
          onActivateTab={(id) => void ema.activateTab(id)}
          onNavigate={(url) => void ema.navigate(url)}
          onBack={() => void ema.simple("go_back")}
          onReload={() => void ema.simple("reload")}
          onViewport={(v) => void ema.setViewport(v)}
          onClickAt={(x, y) => void ema.clickAt(x, y)}
          onKeys={(text, key) => void ema.sendKeys(text, key)}
          onScroll={(dy) => void ema.scrollBy(dy)}
        />

        <div className="grid min-h-0 grid-rows-2 gap-3">
          <AiPanel chat={ema.chat} thinking={ema.thinking} onAsk={ema.ask} onStop={ema.stop} />
          <ActivityLog log={ema.log} />
        </div>
      </div>

      <VaultDialog open={vaultOpen} onOpenChange={setVaultOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} onSaved={connect} />
      <ApprovalDialog approval={ema.approval} />
    </main>
  );
}
