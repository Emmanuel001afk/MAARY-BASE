import { useEffect, useState } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { saveCredential } from "@/lib/ema.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Row = {
  id: string;
  site: string;
  label: string | null;
  username: string | null;
  allow_ai: boolean;
};

export function VaultDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [notes, setNotes] = useState("");
  const [allowAi, setAllowAi] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    const { data } = await supabase
      .from("vault_credentials")
      .select("id, site, label, username, allow_ai")
      .order("site");
    setRows((data ?? []) as Row[]);
  }

  useEffect(() => {
    if (open) void load();
  }, [open]);

  async function add() {
    if (!site.trim() || !secret) {
      toast.error("Site and password are required");
      return;
    }
    setSaving(true);
    try {
      await saveCredential({
        data: { site, label: site, username, secret, notes, allow_ai: allowAi },
      });
      setSite("");
      setUsername("");
      setSecret("");
      setNotes("");
      toast.success("Saved to the encrypted vault");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await supabase.from("vault_credentials").delete().eq("id", id);
    await load();
  }

  async function toggleAi(row: Row) {
    await supabase.from("vault_credentials").update({ allow_ai: !row.allow_ai }).eq("id", row.id);
    await load();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <KeyRound className="size-4 text-primary" /> Credential vault
          </DialogTitle>
          <DialogDescription>
            Passwords are encrypted before they are stored and only ever decrypted on the server
            when EMA logs you in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Site</Label>
              <Input value={site} onChange={(e) => setSite(e.target.value)} placeholder="github.com" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Username / email</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Password / token</Label>
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes (2FA hints, etc.)</Label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
            <span className="text-xs text-muted-foreground">Let EMA use this credential</span>
            <Switch checked={allowAi} onCheckedChange={setAllowAi} />
          </div>
          <Button onClick={add} disabled={saving} className="w-full">
            Add credential
          </Button>
        </div>

        <ul className="max-h-56 space-y-1 overflow-auto">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono">{row.site}</p>
                <p className="truncate text-muted-foreground">{row.username}</p>
              </div>
              <Switch checked={row.allow_ai} onCheckedChange={() => toggleAi(row)} />
              <Button size="icon" variant="ghost" className="size-7" onClick={() => remove(row.id)}>
                <Trash2 className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
