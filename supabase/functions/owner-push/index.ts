import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const OWNER_ID = "dce2d514-964d-49be-b83d-45e6721b49a7";
const allowedOrigins = new Set(["https://lane-video-ai.com","https://www.lane-video-ai.com","https://lane-video-ai.vercel.app"]);
function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const requestedHeaders = req.headers.get("Access-Control-Request-Headers");
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin) ? origin : "https://lane-video-ai.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": requestedHeaders || "authorization, x-client-info, apikey, content-type, x-supabase-api-version, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin, Access-Control-Request-Headers",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: corsHeaders(req) });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return Response.json({ error: "Authentication required" }, { status: 401, headers: corsHeaders(req) });

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
    const subject = Deno.env.get("VAPID_SUBJECT");
    if (!supabaseUrl || !anonKey || !serviceKey || !publicKey || !privateKey || !subject) {
      return Response.json({ error: "Push service is not fully configured" }, { status: 500, headers: corsHeaders(req) });
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser(token);
    if (userError || !user || user.id !== OWNER_ID) {
      return Response.json({ error: "Owner access required" }, { status: 403, headers: corsHeaders(req) });
    }

    const body = await req.json().catch(() => ({}));
    if (body.action === "public_key") {
      return Response.json({ publicKey }, { headers: corsHeaders(req) });
    }
    if (body.action !== "test") {
      return Response.json({ error: "Unsupported action" }, { status: 400, headers: corsHeaders(req) });
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: subscriptions, error: dbError } = await admin
      .from("push_subscriptions")
      .select("id,endpoint,p256dh,auth_key")
      .eq("owner_id", OWNER_ID);
    if (dbError) throw dbError;
    if (!subscriptions?.length) {
      return Response.json({ error: "No phone subscription found. Enable notifications from the owner dashboard first." }, { status: 404, headers: corsHeaders(req) });
    }

    webpush.setVapidDetails(subject, publicKey, privateKey);
    const payload = JSON.stringify({
      title: "LANE AI STUDIO",
      body: "Тестовото известие работи успешно!",
      tag: "lane-owner-push-test",
      url: "/admin",
    });

    let sent = 0;
    let removed = 0;
    const failures = [];
    for (const row of subscriptions) {
      try {
        await webpush.sendNotification({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth_key },
        }, payload);
        sent++;
      } catch (error) {
        const statusCode = Number(error?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await admin.from("push_subscriptions").delete().eq("id", row.id);
          removed++;
        } else {
          failures.push(statusCode || "send_error");
        }
      }
    }

    return Response.json({ success: sent > 0, sent, removed, failed: failures.length }, {
      status: sent > 0 ? 200 : 502,
      headers: corsHeaders(req),
    });
  } catch (error) {
    console.error("owner-push error:", error);
    return Response.json({ error: "Push request failed" }, { status: 500, headers: corsHeaders(req) });
  }
});
