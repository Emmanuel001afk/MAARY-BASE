import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import { getSettings, saveSettings } from "@/lib/ema.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function SettingsDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("gpt-4o-mini");
  const [apiKey, setApiKey] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [agentUrl, setAgentUrl] = useState("ws://localhost:7788");
  const [agentToken, setAgentToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const s = await getSettings();
      setBaseUrl(s.ai_base_url);
      setModel(s.ai_model);
      setAgentUrl(s.agent_url);
      setAgentToken(s.agent_token);
      setKeySet(s.ai_key_set);
    })();
  }, [open]);

  async function save() {
    setSaving(true);
    try {
      await saveSettings({
        data: {
          ai_base_url: baseUrl,
          ai_model: model,
          agent_url: agentUrl,
          agent_token: agentToken,
          ai_key: apiKey || null,
        },
      });
      setApiKey("");
      toast.success("Settings saved");
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Settings2 className="size-4 text-primary" /> Settings
          </DialogTitle>
          <DialogDescription>
            Your own OpenAI-compatible endpoint drives the browser. The browser itself runs on your
            machine through the EMA agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">AI base URL</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Model</Label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono text-xs" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              API key {keySet && <span className="text-muted-foreground">(saved — leave blank to keep)</span>}
            </Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-…"
              className="font-mono text-xs"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Agent URL</Label>
              <Input value={agentUrl} onChange={(e) => setAgentUrl(e.target.value)} className="font-mono text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Agent token</Label>
              <Input
                value={agentToken}
                onChange={(e) => setAgentToken(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <Button onClick={save} disabled={saving} className="w-full">
            Save and reconnect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
