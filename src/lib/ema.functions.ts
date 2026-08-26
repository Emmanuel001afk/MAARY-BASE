import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ChatMessage } from "./ema.server";

export type SettingsInput = {
  ai_base_url: string;
  ai_model: string;
  agent_url: string;
  agent_token: string | null;
  ai_key?: string | null;
};

export const getSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data } = await supabase
      .from("app_settings")
      .select("ai_base_url, ai_model, agent_url, agent_token, ai_key_encrypted")
      .eq("user_id", userId)
      .maybeSingle();

    if (!data) {
      await supabase.from("app_settings").insert({ user_id: userId });
      return {
        ai_base_url: "https://api.openai.com/v1",
        ai_model: "gpt-4o-mini",
        agent_url: "ws://localhost:7788",
        agent_token: "",
        ai_key_set: false,
      };
    }
    return {
      ai_base_url: data.ai_base_url,
      ai_model: data.ai_model,
      agent_url: data.agent_url,
      agent_token: data.agent_token ?? "",
      ai_key_set: Boolean(data.ai_key_encrypted),
    };
  });

export const saveSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SettingsInput) => input)
  .handler(async ({ data, context }) => {
    const { encryptSecret } = await import("./crypto.server");
    const { supabase, userId } = context;
    const patch = {
      user_id: userId,
      ai_base_url: data.ai_base_url,
      ai_model: data.ai_model,
      agent_url: data.agent_url,
      agent_token: data.agent_token,
      updated_at: new Date().toISOString(),
      ...(data.ai_key ? { ai_key_encrypted: await encryptSecret(data.ai_key) } : {}),
    };
    const { error } = await supabase.from("app_settings").upsert(patch, { onConflict: "user_id" });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const saveCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      id?: string;
      site: string;
      label: string;
      username: string;
      secret?: string;
      notes: string;
      allow_ai: boolean;
    }) => input,
  )
  .handler(async ({ data, context }) => {
    const { encryptSecret } = await import("./crypto.server");
    const { supabase, userId } = context;
    const row = {
      user_id: userId,
      site: data.site.trim().toLowerCase(),
      label: data.label,
      username: data.username,
      notes: data.notes,
      allow_ai: data.allow_ai,
      updated_at: new Date().toISOString(),
      ...(data.secret ? { secret_encrypted: await encryptSecret(data.secret) } : {}),
    };
    if (data.id) {
      const { error } = await supabase
        .from("vault_credentials")
        .update(row)
        .eq("id", data.id)
        .eq("user_id", userId);
      if (error) throw new Error(error.message);
    } else {
      if (!data.secret) throw new Error("A secret is required for a new credential");
      const { error } = await supabase
        .from("vault_credentials")
        .insert({ ...row, secret_encrypted: await encryptSecret(data.secret) });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const revealCredential = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { site: string; forAi?: boolean }) => input)
  .handler(async ({ data, context }) => {
    const { decryptSecret } = await import("./crypto.server");
    const { supabase, userId } = context;
    const host = data.site.trim().toLowerCase().replace(/^www\./, "");
    const { data: rows, error } = await supabase
      .from("vault_credentials")
      .select("id, site, username, secret_encrypted, allow_ai, notes")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    const match = (rows ?? []).find(
      (r) => host.includes(r.site.replace(/^www\./, "")) || r.site.includes(host),
    );
    if (!match) throw new Error(`No credential saved for ${host}`);
    if (data.forAi && !match.allow_ai) throw new Error(`AI use is disabled for ${match.site}`);
    return {
      site: match.site,
      username: match.username ?? "",
      secret: await decryptSecret(match.secret_encrypted),
      notes: match.notes ?? "",
    };
  });

export const aiChat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { messages: ChatMessage[]; tools: unknown[] }) => input)
  .handler(async ({ data, context }) => {
    const { callOpenAICompatible } = await import("./ema.server");
    const { supabase, userId } = context;
    const { data: settings } = await supabase
      .from("app_settings")
      .select("ai_base_url, ai_model, ai_key_encrypted")
      .eq("user_id", userId)
      .maybeSingle();
    if (!settings?.ai_key_encrypted) {
      throw new Error("Add your AI API key in Settings first.");
    }
    return callOpenAICompatible({
      baseUrl: settings.ai_base_url,
      model: settings.ai_model,
      keyEncrypted: settings.ai_key_encrypted,
      messages: data.messages,
      tools: data.tools,
    });
  });

/**
 * One-time owner bootstrap. Only succeeds when the email matches EMA_OWNER_EMAIL
 * and no owner account exists yet, so this is never a public sign-up.
 */
export const createOwnerAccount = createServerFn({ method: "POST" })
  .inputValidator((input: { email: string; password: string }) => input)
  .handler(async ({ data }) => {
    const ownerEmail = process.env["EMA_OWNER_EMAIL"]?.trim().toLowerCase();
    if (!ownerEmail || data.email.trim().toLowerCase() !== ownerEmail) {
      throw new Error("This is a private app.");
    }
    if (data.password.length < 10) throw new Error("Use at least 10 characters.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true });
    if ((count ?? 0) > 0) throw new Error("The owner account already exists.");
    const { error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
