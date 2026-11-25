import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const OWNER_USER_ID = "dce2d514-964d-49be-b83d-45e6721b49a7";
function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const apiKey = Deno.env.get("SOUNDVERSE_API_KEY");
  if (!supabaseUrl || !anonKey) return respond({ error: "Supabase configuration is incomplete." }, 500);
  if (!apiKey) return respond({ success: false, configured: false, error: "SOUNDVERSE_API_KEY is not configured." }, 503);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return respond({ error: "Authentication required." }, 401);
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(authHeader.slice(7));
  if (error || !data.user) return respond({ error: "Invalid login session." }, 401);
  if (data.user.id !== OWNER_USER_ID) return respond({ error: "Not authorized." }, 403);

  try {
    const providerResponse = await fetch("https://apiv2.soundverse.ai/v1/account/balance", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    const payload = await providerResponse.json().catch(() => ({}));
    if (!providerResponse.ok) {
      const providerError = typeof payload?.error === "string" ? payload.error : "Soundverse rejected the API key.";
      return respond({ success: false, configured: true, valid: false, providerStatus: providerResponse.status, error: providerError }, 502);
    }
    return respond({
      success: true,
      configured: true,
      valid: true,
      provider: "Soundverse",
      balance: {
        total_effective: payload?.total_effective ?? null,
        base_effective: payload?.base_effective ?? null,
        extra_tokens: payload?.extra_tokens ?? null,
      },
    });
  } catch {
    return respond({ success: false, configured: true, valid: false, error: "Could not reach Soundverse API." }, 502);
  }
});
