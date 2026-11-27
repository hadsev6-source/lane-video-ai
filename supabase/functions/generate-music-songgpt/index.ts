import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const API = "https://www.songgpt.ai/openapi/v1";
const CREDITS = 25;
const MAX_AUDIO = 50 * 1024 * 1024;
const OWNER_ID = "dce2d514-964d-49be-b83d-45e6721b49a7";
const OWNER_USD_EUR = 0.9168;

function out(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
async function json(res: Response) { try { return await res.json(); } catch { return {}; } }
function errText(v: any, fallback: string) {
  return typeof v?.message === "string" && v.message ? v.message :
    typeof v?.error === "string" && v.error ? v.error : fallback;
}
function isMp3Audio(bytes: Uint8Array) {
  if (bytes.length < 4) return false;
  const hasId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const hasFrameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  return hasId3 || hasFrameSync;
}
function ownerCredits() {
  const rate = Number(Deno.env.get("OWNER_USD_TO_EUR") || OWNER_USD_EUR);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Invalid owner FX configuration.");
  return Math.max(1, Math.round(0.10 * rate * 140));
}
async function refund(admin: any, jobId: string) {
  const { data, error } = await admin.rpc("refund_music_credits", { p_job_id: jobId });
  if (error) console.error("SongGPT refund RPC failed:", error);
  return !error && data === true;
}
async function recordOwnerApiCost(admin: any, jobId: string, credits: number, duration: number) {
  const usdToEur = Number(Deno.env.get("OWNER_USD_TO_EUR") || OWNER_USD_EUR);
  const amountUsd = 0.10;
  const { error } = await admin.from("owner_api_costs").insert({
    user_id: OWNER_ID,
    service: "music_generation",
    provider: "SongGPT",
    model: "songgpt-v1",
    amount_usd: amountUsd,
    usd_to_eur: usdToEur,
    amount_eur: amountUsd * usdToEur,
    credits_charged: credits,
    generation_id: jobId,
    duration_seconds: duration,
    metadata: { provider: "SongGPT", request_cost_usd: amountUsd }
  });
  if (error) console.error("SongGPT owner API cost logging failed:", error);
}
async function signTracks(admin: any, job: any, userId: string) {
  const { data: rows, error } = await admin.from("songgpt_music_job_tracks")
    .select("track_index,title,duration_seconds,storage_path")
    .eq("job_id", job.id).eq("user_id", userId).order("track_index");
  if (error) throw error;
  const tracks = [];
  for (const row of rows || []) {
    const name = row.storage_path.split("/").pop() || `LANE_Song_${row.track_index}.mp3`;
    const [{ data: play, error: playErr }, { data: dl, error: dlErr }] = await Promise.all([
      admin.storage.from("user-songs").createSignedUrl(row.storage_path, 3600),
      admin.storage.from("user-songs").createSignedUrl(row.storage_path, 3600, { download: name }),
    ]);
    if (!playErr && play?.signedUrl) tracks.push({
      version: row.track_index, title: row.title || `Version ${row.track_index}`,
      audioUrl: play.signedUrl, downloadUrl: dlErr ? null : dl?.signedUrl || null,
      fileName: name, durationSeconds: row.duration_seconds,
    });
  }
  return tracks;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "Method not allowed." }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const apiKey = Deno.env.get("SONGGPT_API_KEY");
  if (!url || !anon || !service) return out({ error: "Supabase configuration is incomplete." }, 500);
  if (!apiKey && (await req.clone().json().catch(() => ({}))).action !== "health") return out({ error: "SONGGPT_API_KEY is not configured." }, 500);

  const auth = req.headers.get("Authorization");
  if (!auth) return out({ error: "Authentication required." }, 401);
  const userClient = createClient(url, anon);
  const { data: authData, error: authError } = await userClient.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (authError || !authData.user) return out({ error: "Invalid login session." }, 401);
  const user = authData.user;
  const admin = createClient(url, service, { auth: { autoRefreshToken: false, persistSession: false } });
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  try {
    const body = await req.json();
    if (body.action === "health") {
      return out({ success: true, provider: "SongGPT", apiKeyConfigured: Boolean(apiKey), databaseReady: true });
    }
    if (!apiKey) return out({ error: "SONGGPT_API_KEY is not configured." }, 500);
    if (body.action === "start") {
      const mode = String(body.lyricsMode || "").toLowerCase();
      const instrumental = mode.includes("no lyrics") || mode.includes("instrumental") ||
        String(body.voiceCharacter || "").toLowerCase() === "instrumental";
      const ownLyrics = mode.includes("my own") || mode.includes("my_own") || mode.includes("custom");
      const title = String(body.title || "My AI Song").trim().slice(0, 80);
      const style = [body.tags, body.customStyle, body.mood && `mood: ${body.mood}`,
        body.language && `language: ${body.language}`, body.bpm && `tempo: ${body.bpm}`,
        body.voiceCharacter && !instrumental && `vocal character: ${body.voiceCharacter}`,
        body.instructions].filter(Boolean).join(", ").slice(0, 1000);
      const lyrics = String(body.lyrics || "").trim();
      const duration = Number(body.durationSeconds || 240);
      if (![60, 120, 180, 240].includes(duration)) return out({ error: "Choose a duration from 1 to 4 minutes." }, 400);
      if (!style) return out({ error: "Please enter a music style or description." }, 400);
      if (ownLyrics && !instrumental && !lyrics) return out({ error: "Please enter your own lyrics." }, 400);
      if (lyrics.length > 5000) return out({ error: "Lyrics exceed SongGPT's 5000-character limit." }, 400);

      const requestBody: Record<string, unknown> = instrumental || ownLyrics
        ? { mode: "custom", model: "songgpt-v1", title, style, instrumental, duration, ...(ownLyrics && !instrumental ? { prompt: lyrics } : {}) }
        : { mode: "simple", model: "songgpt-v1", prompt: style.slice(0, 3000), instrumental: false, duration_ms: duration * 1000, n: 2 };

      const credits = user.id === OWNER_ID ? ownerCredits() : CREDITS;
      const { data: job, error: insertError } = await admin.from("music_generation_jobs").insert({
        user_id: user.id, prompt: style, lyrics: instrumental ? "[inst]" : lyrics,
        title, genre: style.slice(0, 250), duration_seconds: duration,
        credits_charged: credits, lyrics_mode: instrumental ? "no_lyrics" : ownLyrics ? "my_own" : "ai_write",
        provider_model: "songgpt-v1", status: "queued",
      }).select("id").single();
      if (insertError || !job) return out({ error: "Could not create music job." }, 500);
      const { data: charged, error: debitError } = await admin.rpc("debit_music_credits", { p_job_id: job.id });
      if (debitError || charged !== true) {
        await admin.from("music_generation_jobs").delete().eq("id", job.id).eq("user_id", user.id);
        return out({ error: `Not enough credits. You need ${credits} credits.` }, 402);
      }

      let providerResponse: Response;
      try {
        providerResponse = await fetch(`${API}/music/generate`, { method: "POST", headers, body: JSON.stringify(requestBody) });
      } catch (e) {
        // Submission outcome is unknown: SongGPT has no idempotency key. Do not auto-refund or resubmit.
        await admin.from("music_generation_jobs").update({
          status: "queued", error_message: "SongGPT submission outcome is unknown. Check provider task before retrying.",
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("user_id", user.id);
        return out({ success: false, status: "submission_unknown", jobId: job.id, error: "The provider connection timed out. Do not submit again; contact support to check the task." }, 202);
      }
      const payload = await json(providerResponse);
      if (!providerResponse.ok || payload?.code !== 0 || !payload?.data?.unique_id) {
        const reason = errText(payload, "SongGPT rejected the request.");
        const didRefund = await refund(admin, job.id);
        await admin.from("music_generation_jobs").update({ status: "failed", error_message: reason.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", job.id).eq("user_id", user.id);
        return out({ success: false, status: "failed", error: reason, refunded: didRefund }, 502);
      }
      const uniqueId = String(payload.data.unique_id);
      if (user.id === OWNER_ID) await recordOwnerApiCost(admin, job.id, credits, duration);
      const { error: saveError } = await admin.from("music_generation_jobs").update({
        request_id: uniqueId, status: "processing", updated_at: new Date().toISOString(),
      }).eq("id", job.id).eq("user_id", user.id);
      if (saveError) {
        console.error("Could not save SongGPT unique_id:", saveError);
        return out({ success: true, status: "processing", jobId: job.id, warning: "Task started; support recovery may be required." });
      }
      return out({ success: true, status: "processing", jobId: job.id, requestId: uniqueId, creditsUsed: credits, versionsExpected: 2 });
    }

    if (body.action === "status") {
      const jobId = String(body.jobId || "");
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) return out({ error: "Invalid job ID." }, 400);
      const { data: job, error: jobError } = await admin.from("music_generation_jobs")
        .select("*").eq("id", jobId).eq("user_id", user.id).single();
      if (jobError || !job) return out({ error: "Music job not found." }, 404);
      if (job.status === "completed") {
        const tracks = await signTracks(admin, job, user.id);
        return out({ success: true, status: "completed", tracks, audioUrl: tracks[0]?.audioUrl || null,
          downloadUrl: tracks[0]?.downloadUrl || null, fileName: tracks[0]?.fileName || null,
          creditsUsed: Number(job.credits_charged || CREDITS), durationSeconds: job.duration_seconds });
      }
      if (job.status === "failed") return out({ success: false, status: "failed", error: job.error_message || "SongGPT generation failed.", refunded: job.refunded });
      if (!job.request_id) return out({ success: false, status: job.status, jobId: job.id, error: job.error_message || "Task ID is not available; do not submit again." }, 202);

      const statusRes = await fetch(`${API}/music/tasks/status`, {
        method: "POST", headers, body: JSON.stringify({ unique_ids: [job.request_id] }),
      });
      const statusPayload = await json(statusRes);
      if (!statusRes.ok || statusPayload?.code !== 0) return out({ error: errText(statusPayload, "Could not check SongGPT task status.") }, 502);
      const task = (statusPayload?.data?.tasks || []).find((t: any) => t.unique_id === job.request_id);
      if (!task) return out({ success: true, status: "processing", jobId: job.id, message: "Task is not yet visible; do not resubmit." });
      if (!task.is_complete) return out({ success: true, status: "processing", jobId: job.id, providerStatus: task.status });

      if (task.status === "failed") {
        const didRefund = await refund(admin, job.id);
        await admin.from("music_generation_jobs").update({
          status: "failed", error_message: String(task.error_message || "SongGPT task failed.").slice(0, 1000),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("user_id", user.id).neq("status", "completed");
        return out({ success: false, status: "failed", error: task.error_message || "SongGPT task failed.", refunded: didRefund });
      }

      const songs = Array.isArray(task.songs) ? task.songs : [];
      const available = songs.filter((s: any) => typeof s.audio_url === "string" && /^https:\/\//i.test(s.audio_url)).slice(0, 3);
      if (!available.length) {
        await admin.from("music_generation_jobs").update({
          status: "processing", error_message: "SongGPT reports completion, but playable audio URLs are not available yet. Poll again; do not resubmit.",
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("user_id", user.id);
        return out({ success: true, status: "processing", jobId: job.id,
          warning: "SongGPT reports completion, but no playable audio URL is available yet. Checking again is safe; do not generate again.",
          creditsUsed: Number(job.credits_charged || CREDITS) }, 202);
      }

      const uploadedPaths: string[] = [];
      try {
        for (let i = 0; i < available.length; i++) {
          const song = available[i];
          const audioRes = await fetch(song.audio_url);
          if (!audioRes.ok) throw new Error(`Could not download SongGPT version ${i + 1}.`);
          const blob = await audioRes.blob();
          if (!blob.size || blob.size > MAX_AUDIO) throw new Error("SongGPT returned an invalid audio file size.");
          const responseType = (audioRes.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
          const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
          const allowedType = !responseType || ["audio/mpeg", "audio/mp3", "audio/x-mpeg", "application/octet-stream", "binary/octet-stream"].includes(responseType);
          if (!allowedType || !isMp3Audio(signature)) {
            throw new Error("SongGPT returned audio that is not a valid MP3. LANE accepts MP3 format only.");
          }
          const name = `LANE_Song_${job.id}_v${i + 1}.mp3`;
          const path = `${user.id}/${name}`;
          const { error: uploadError } = await admin.storage.from("user-songs").upload(path, blob, { contentType: "audio/mpeg", cacheControl: "3600", upsert: true });
          if (uploadError) throw uploadError;
          uploadedPaths.push(path);
          const { error: rowError } = await admin.from("songgpt_music_job_tracks").upsert({
            job_id: job.id, user_id: user.id, track_index: i + 1,
            provider_song_id: Number.isFinite(Number(song.id)) ? Number(song.id) : null,
            title: song.title || `Version ${i + 1}`, duration_seconds: song.duration ?? null,
            lyrics: song.lyrics ?? null, style: song.style ?? null, storage_path: path,
          }, { onConflict: "job_id,track_index" });
          if (rowError) throw rowError;
        }
        const { data: firstTrack } = await admin.from("songgpt_music_job_tracks")
          .select("storage_path").eq("job_id", job.id).eq("user_id", user.id)
          .eq("track_index", 1).maybeSingle();
        await admin.from("music_generation_jobs").update({
          status: "completed", storage_path: firstTrack?.storage_path || null,
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("user_id", user.id);
        const tracks = await signTracks(admin, job, user.id);
        return out({ success: true, status: "completed", tracks, audioUrl: tracks[0]?.audioUrl || null,
          downloadUrl: tracks[0]?.downloadUrl || null, fileName: tracks[0]?.fileName || null,
          creditsUsed: Number(job.credits_charged || CREDITS), durationSeconds: job.duration_seconds,
          warning: available.length < 2 ? "SongGPT returned fewer than two playable versions." : undefined });
      } catch (e) {
        console.error("SongGPT audio storage error:", e);
        const message = e instanceof Error ? e.message : "Could not save SongGPT audio.";
        if (message.includes("not a valid MP3")) {
          if (uploadedPaths.length) await admin.storage.from("user-songs").remove(uploadedPaths);
          await admin.from("songgpt_music_job_tracks").delete().eq("job_id", job.id).eq("user_id", user.id);
          const didRefund = await refund(admin, job.id);
          await admin.from("music_generation_jobs").update({
            status: "failed", error_message: message.slice(0, 1000), updated_at: new Date().toISOString(),
          }).eq("id", job.id).eq("user_id", user.id).neq("status", "completed");
          return out({ success: false, status: "failed", error: message, refunded: didRefund }, 502);
        }
        // Provider task succeeded; never resubmit. Keep transient storage failures in processing for support retry.
        return out({ success: true, status: "processing", jobId: job.id, warning: "The task completed, but saving its MP3 needs a retry by support. Do not generate again." }, 202);
      }
    }
    return out({ error: "Unknown action. Use start or status." }, 400);
  } catch (e) {
    console.error("SongGPT test function error:", e);
    return out({ error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});
