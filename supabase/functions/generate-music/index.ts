import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const WAVESPEED_MODEL = "wavespeed-ai/ace-step";
const WAVESPEED_PROMPT_MODEL = "wavespeed-ai/ace-step-prompt-to-audio";
const WAVESPEED_API = "https://api.wavespeed.ai/api/v3";
const MUSIC_CREDITS = 25;
const MAX_AUDIO_SIZE = 50 * 1024 * 1024;

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function readJson(res: Response): Promise<any> {
  try { return await res.json(); } catch { return {}; }
}

function normalizeLyricsMode(value: unknown): string {
  const mode = String(value || "").trim().toLowerCase();
  if (["ai write lyrics", "ai_write_lyrics", "ai-write-lyrics", "ai"].includes(mode)) return "ai_write";
  if (["my own lyrics", "my_own", "my-own-lyrics", "custom"].includes(mode)) return "my_own";
  if (["no lyrics", "no_lyrics", "no-lyrics", "instrumental"].includes(mode)) return "no_lyrics";
  return "";
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    for (const key of ["detail", "error", "message"]) {
      if (typeof item[key] === "string" && String(item[key]).trim()) return String(item[key]).trim();
    }
  }
  return fallback;
}

function getProviderData(payload: any): any {
  return payload?.data && typeof payload.data === "object" ? payload.data : payload;
}

function extractAudioUrl(outputs: unknown): string | null {
  if (!Array.isArray(outputs)) return null;
  for (const item of outputs) {
    if (typeof item === "string" && /^https?:\/\//i.test(item)) return item;
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of ["url", "audio_url", "audioUrl", "file_url", "download_url"]) {
        const value = record[key];
        if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
      }
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return response({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const wavespeedKey = Deno.env.get("WAVESPEED_API_KEY");

  if (!supabaseUrl || !anonKey || !serviceKey) {
    return response({ error: "Supabase environment configuration is incomplete." }, 500);
  }
  if (!wavespeedKey) return response({ error: "WAVESPEED_API_KEY is not configured." }, 500);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return response({ error: "Authentication required." }, 401);
  const token = authHeader.replace(/^Bearer\s+/i, "");

  const userClient = createClient(supabaseUrl, anonKey);
  const { data: userData, error: authError } = await userClient.auth.getUser(token);
  if (authError || !userData.user) return response({ error: "Invalid login session." }, 401);

  const user = userData.user;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const providerHeaders = {
    Authorization: `Bearer ${wavespeedKey}`,
    "Content-Type": "application/json",
  };

  try {
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "start") {
      const lyricsMode = normalizeLyricsMode(body.lyricsMode ?? body.lyrics_mode);
      if (!lyricsMode) {
        return response({ error: "Invalid lyrics mode. Choose AI Write Lyrics, My Own Lyrics, or No Lyrics." }, 400);
      }

      const title = String(body.title || "My AI Song").trim();
      const style = String(body.tags || body.genre || body.prompt || "").trim();
      const additionalInstructions = String(body.instructions || body.additionalInstructions || "").trim();
      const lyricsInput = String(body.lyrics || "").trim();
      const mood = String(body.mood || "").trim();
      const language = String(body.language || "").trim();
      const bpm = String(body.bpm || "").trim();
      const voiceCharacter = String(body.voiceCharacter || body.voice_character || "").trim();
      const customStyle = String(body.customStyle || body.custom_style || "").trim();
      const requestedDuration = Number(body.durationSeconds ?? body.duration_seconds ?? 240);
      const allowedDurations = [60, 120, 180, 240];

      if (!allowedDurations.includes(requestedDuration)) {
        return response({ error: "Choose a song length between 1 and 4 minutes." }, 400);
      }
      if (!style && !customStyle) return response({ error: "Please enter a music style or description." }, 400);
      if (lyricsMode === "my_own" && !lyricsInput) return response({ error: "Please enter your own lyrics." }, 400);
      if (style.length > 1500 || additionalInstructions.length > 3000 || lyricsInput.length > 12000 || customStyle.length > 1000) {
        return response({ error: "The music prompt or lyrics are too long." }, 400);
      }

      const promptParts = [
        style,
        customStyle,
        mood && `mood: ${mood}`,
        language && `language: ${language}`,
        bpm && `tempo: ${bpm}`,
        voiceCharacter && `vocal character: ${voiceCharacter}`,
        additionalInstructions,
        lyricsMode === "ai_write" && lyricsInput ? `song theme and lyrical ideas: ${lyricsInput}` : "",
      ].filter(Boolean);
      const tags = promptParts.join(", ").slice(0, 3000);
      const providerLyrics = lyricsMode === "my_own" ? lyricsInput : lyricsMode === "no_lyrics" ? "[inst]" : "";
      const providerModel = lyricsMode === "ai_write" ? WAVESPEED_PROMPT_MODEL : WAVESPEED_MODEL;
      const providerInput = lyricsMode === "ai_write"
        ? { prompt: tags, instrumental: false, duration: requestedDuration, seed: -1 }
        : { tags, lyrics: providerLyrics, duration: requestedDuration, seed: -1 };

      const { data: job, error: jobError } = await admin
        .from("music_generation_jobs")
        .insert({
          user_id: user.id,
          prompt: tags,
          lyrics: providerLyrics,
          title: title.slice(0, 120),
          genre: (style || customStyle).slice(0, 250),
          duration_seconds: requestedDuration,
          credits_charged: MUSIC_CREDITS,
          lyrics_mode: lyricsMode,
          provider_model: providerModel,
          status: "queued",
        })
        .select("id")
        .single();

      if (jobError || !job) {
        console.error("Music job creation error:", jobError);
        return response({ error: "Could not create the music generation job." }, 500);
      }

      const { data: charged, error: debitError } = await admin.rpc("debit_music_credits", { p_job_id: job.id });
      if (debitError || charged !== true) {
        await admin.from("music_generation_jobs").delete().eq("id", job.id).eq("user_id", user.id);
        return response({ error: "Not enough credits. You need 25 credits." }, 402);
      }

      let providerResponse: Response;
      try {
        providerResponse = await fetch(`${WAVESPEED_API}/${providerModel}`, {
          method: "POST",
          headers: providerHeaders,
          body: JSON.stringify(providerInput),
        });
      } catch (providerError) {
        console.error("WaveSpeed submission connection error:", providerError);
        await admin.rpc("refund_music_credits", { p_job_id: job.id });
        await admin.from("music_generation_jobs").update({
          status: "failed",
          error_message: "Could not connect to WaveSpeed.",
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        return response({ error: "Could not connect to the music provider. Credits were refunded." }, 502);
      }

      const providerPayload = await readJson(providerResponse);
      const providerData = getProviderData(providerPayload);
      const requestId = providerData?.id;

      if (!providerResponse.ok || !requestId) {
        const reason = errorMessage(providerData?.error || providerPayload, "WaveSpeed rejected the music request.");
        await admin.rpc("refund_music_credits", { p_job_id: job.id });
        await admin.from("music_generation_jobs").update({
          status: "failed",
          error_message: reason.slice(0, 1000),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id);
        return response({ error: reason, refunded: true }, 502);
      }

      const { error: updateError } = await admin.from("music_generation_jobs")
        .update({ request_id: String(requestId), status: "processing", updated_at: new Date().toISOString() })
        .eq("id", job.id).eq("user_id", user.id);

      if (updateError) {
        console.error("Could not save WaveSpeed prediction ID:", updateError);
        return response({ success: true, jobId: job.id, requestId, status: "processing", warning: "The request started, but its database record needs recovery." });
      }

      return response({
        success: true,
        jobId: job.id,
        requestId,
        status: "processing",
        lyricsMode,
        providerModel,
        creditsUsed: MUSIC_CREDITS,
        durationSeconds: requestedDuration,
        message: "Your music generation has started.",
      });
    }

    if (action === "status") {
      const jobId = String(body.jobId || "");
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) return response({ error: "Invalid job ID." }, 400);

      const { data: job, error: jobError } = await admin.from("music_generation_jobs")
        .select("*").eq("id", jobId).eq("user_id", user.id).single();
      if (jobError || !job) return response({ error: "Music job not found." }, 404);

      if (job.status === "completed") {
        if (!job.storage_path) return response({ error: "The completed job has no stored audio file." }, 500);
        const fileName = job.storage_path.split("/").pop() || "AI_Music.mp3";
        const [{ data: signedFile, error: signedError }, { data: downloadFile, error: downloadError }] = await Promise.all([
          admin.storage.from("user-songs").createSignedUrl(job.storage_path, 3600),
          admin.storage.from("user-songs").createSignedUrl(job.storage_path, 3600, { download: fileName }),
        ]);
        if (signedError || !signedFile?.signedUrl) return response({ error: "Audio is saved, but a playback link could not be created." }, 500);
        return response({ success: true, status: "completed", audioUrl: signedFile.signedUrl, downloadUrl: downloadError ? null : downloadFile?.signedUrl || null, fileName, creditsUsed: MUSIC_CREDITS, durationSeconds: job.duration_seconds });
      }

      if (job.status === "failed") {
        return response({ success: false, status: "failed", error: job.error_message || "Music generation failed.", refunded: job.refunded });
      }
      if (!job.request_id) return response({ error: "Provider request is not registered yet." }, 409);

      const resultResponse = await fetch(`${WAVESPEED_API}/predictions/${encodeURIComponent(job.request_id)}/result`, {
        headers: { Authorization: `Bearer ${wavespeedKey}` },
      });
      const resultPayload = await readJson(resultResponse);
      const resultData = getProviderData(resultPayload);

      if (!resultResponse.ok) {
        return response({ error: errorMessage(resultData?.error || resultPayload, "Could not check WaveSpeed task status.") }, 502);
      }

      const providerStatus = String(resultData?.status || "").toLowerCase();
      if (["created", "processing", "queued", "in_queue", "in_progress"].includes(providerStatus)) {
        return response({ success: true, status: "processing", jobId: job.id });
      }

      const outputs = Array.isArray(resultData?.outputs) ? resultData.outputs : [];
      const audioUrl = outputs.find((item: unknown) => typeof item === "string" && /^https?:\/\//i.test(item));
      const failed = providerStatus === "failed" || providerStatus === "cancelled" || Boolean(resultData?.error);

      if (!failed && providerStatus !== "completed") {
        return response({ success: true, status: "processing", jobId: job.id });
      }

      if (failed || !audioUrl) {
        const reason = errorMessage(resultData?.error, !audioUrl ? "WaveSpeed completed without returning an audio file." : "The music provider failed to generate audio.");
        const { data: refundSucceeded, error: refundError } = await admin.rpc("refund_music_credits", { p_job_id: job.id });
        if (refundError) console.error("Music credit refund error:", refundError);
        await admin.from("music_generation_jobs").update({
          status: "failed",
          error_message: reason.slice(0, 1000),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("user_id", user.id);
        return response({ success: false, status: "failed", error: reason, refunded: !refundError && refundSucceeded === true });
      }

      try {
        const audioResponse = await fetch(audioUrl);
        if (!audioResponse.ok) throw new Error("Could not download generated audio.");
        const audioBlob = await audioResponse.blob();
        if (!audioBlob.size || audioBlob.size > MAX_AUDIO_SIZE) throw new Error("Generated audio file has an invalid size.");

        const contentType = audioResponse.headers.get("content-type") || "audio/wav";
        const extension = contentType.includes("mpeg") ? "mp3" : contentType.includes("mp4") ? "m4a" : contentType.includes("ogg") ? "ogg" : "wav";
        const fileName = `AI_Music_${job.id}.${extension}`;
        const storagePath = `${user.id}/${fileName}`;

        const { error: uploadError } = await admin.storage.from("user-songs").upload(storagePath, audioBlob, {
          contentType,
          cacheControl: "3600",
          upsert: true,
        });
        if (uploadError) throw new Error("Could not save generated audio: " + uploadError.message);

        const { data: completedJob, error: completeError } = await admin.from("music_generation_jobs")
          .update({ status: "completed", storage_path: storagePath, audio_url: null, updated_at: new Date().toISOString() })
          .eq("id", job.id).eq("user_id", user.id)
          .select("id").maybeSingle();

        if (completeError || !completedJob) throw new Error("Audio was saved, but the job status could not be safely updated.");

        const [{ data: signedFile, error: signedError }, { data: downloadFile, error: downloadError }] = await Promise.all([
          admin.storage.from("user-songs").createSignedUrl(storagePath, 3600),
          admin.storage.from("user-songs").createSignedUrl(storagePath, 3600, { download: fileName }),
        ]);
        return response({
          success: true,
          status: "completed",
          audioUrl: signedError ? null : signedFile?.signedUrl || null,
          downloadUrl: downloadError ? null : downloadFile?.signedUrl || null,
          fileName,
          creditsUsed: MUSIC_CREDITS,
          durationSeconds: job.duration_seconds,
          lyrics: job.lyrics || "",
          tags: job.genre || "",
          warning: signedError ? "Audio was saved, but the playback link could not be created yet." : undefined,
        });
      } catch (processingError) {
        console.error("Completed audio processing error:", processingError);
        const reason = processingError instanceof Error ? processingError.message : "Could not process the generated audio.";
        const { data: latestJob } = await admin.from("music_generation_jobs").select("status, storage_path").eq("id", job.id).eq("user_id", user.id).maybeSingle();

        if (latestJob?.status === "completed") {
          const { data: signedFile, error: signedError } = await admin.storage.from("user-songs")
            .createSignedUrl(latestJob.storage_path || `${user.id}/AI_Music_${job.id}.wav`, 3600);
          return response({ success: true, status: "completed", audioUrl: signedError ? null : signedFile?.signedUrl || null, fileName: latestJob.storage_path?.split("/").pop() || `AI_Music_${job.id}.wav`, creditsUsed: MUSIC_CREDITS, durationSeconds: job.duration_seconds, warning: "Audio was saved, but a later processing step reported an error." });
        }

        const { data: refundSucceeded, error: refundError } = await admin.rpc("refund_music_credits", { p_job_id: job.id });
        if (refundError) console.error("Music credit refund error:", refundError);
        await admin.from("music_generation_jobs").update({
          status: "failed",
          error_message: reason.slice(0, 1000),
          updated_at: new Date().toISOString(),
        }).eq("id", job.id).eq("user_id", user.id);
        return response({ success: false, status: "failed", error: reason, refunded: !refundError && refundSucceeded === true }, 500);
      }
    }

    return response({ error: "Unknown action. Use start or status." }, 400);
  } catch (error) {
    console.error("generate-music error:", error);
    return response({ error: error instanceof Error ? error.message : "Unexpected music generation error." }, 500);
  }
});
