import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: "Server configuration is incomplete." }, 500);
  }

  const authorization = req.headers.get("Authorization");
  if (!authorization) return json({ error: "Authentication required." }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return json({ error: "Invalid session." }, 401);

  let body: { videoId?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid request body." }, 400); }
  if (!body.videoId || typeof body.videoId !== "string") {
    return json({ error: "Video ID is required." }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: video, error: lookupError } = await admin
    .from("video_generations")
    .select("id, user_id, storage_path")
    .eq("id", body.videoId)
    .eq("user_id", authData.user.id)
    .maybeSingle();

  if (lookupError) return json({ error: lookupError.message }, 500);
  if (!video) return json({ error: "Video not found or access denied." }, 404);

  const { error: storageError } = await admin.storage
    .from("generated-videos")
    .remove([video.storage_path]);
  if (storageError) return json({ error: "Could not delete video file: " + storageError.message }, 500);

  const { error: rowError } = await admin
    .from("video_generations")
    .delete()
    .eq("id", video.id)
    .eq("user_id", authData.user.id);
  if (rowError) return json({ error: "Video file deleted, but database record removal failed: " + rowError.message }, 500);

  return json({ success: true });
});
