
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Нови цени за Make Video with Your Song
const VIDEO_PRICES: Record<number, number> = {
  10: 303,
  15: 607,
  20: 776,
  30: 1114,
};


const OWNER_USER_ID = "dce2d514-964d-49be-b83d-45e6721b49a7";
const OWNER_CREDITS_PER_EUR = 140;
const OWNER_DEFAULT_USD_TO_EUR = 0.9168;
const isOwnerUser = (userId: string) => userId === OWNER_USER_ID;
function ownerCreditsForUsd(usd: number): number {
  const rate = Number(Deno.env.get("OWNER_USD_TO_EUR") || OWNER_DEFAULT_USD_TO_EUR);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(usd) || usd < 0) throw new Error("Invalid owner API cost conversion configuration.");
  return Math.max(1, Math.ceil(usd * rate * OWNER_CREDITS_PER_EUR));
}
async function recordMusicVideoOwnerCost(admin: any, userId: string, task: any) {
  if (!isOwnerUser(userId) || task.model !== "seedance2_5") return;
  const seconds = Number(task.duration || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const usd = Number(task.owner_provider_cost_usd ?? (seconds * 0.20));
  const rate = Number(Deno.env.get("OWNER_USD_TO_EUR") || OWNER_DEFAULT_USD_TO_EUR);
  const metadata = { costSource: task.owner_provider_cost_usd == null ? "published_rate_estimate" : "provider_task_estimate", resolution: "480p", audioReference: true };
  const { data: existing, error: lookupError } = await admin.from("owner_api_costs")
    .select("metadata").eq("user_id", userId).eq("service", "music_video_generation")
    .eq("generation_id", task.id).maybeSingle();
  if (lookupError) { console.error("Could not inspect existing owner music video cost:", lookupError); return; }
  if (existing?.metadata?.costSource === "provider_billing_record") return;
  const { error } = await admin.from("owner_api_costs").upsert({
    user_id: userId, service: "music_video_generation", provider: "Runway", model: "seedance2_5",
    amount_usd: usd, usd_to_eur: rate, amount_eur: usd * rate,
    credits_charged: ownerCreditsForUsd(usd), generation_id: task.id, duration_seconds: seconds,
    metadata,
  }, { onConflict: "user_id,service,generation_id" });
  if (error) console.error("Could not record owner music video API cost:", error);
}

function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function refundCredits(admin: any, jobId: string) {
  const { data, error } = await admin.rpc("refund_video_credits", {
    p_job_id: jobId,
  });

  if (error || data !== true) {
    console.error("Credit refund failed:", error || data);
    return false;
  }

  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return respond({ error: "Method not allowed." }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return respond({ error: "Please sign in first." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const runwayKey = Deno.env.get("RUNWAY_API_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey || !runwayKey) {
      return respond({ error: "Server configuration is incomplete." }, 500);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authError,
    } = await userClient.auth.getUser();

    if (authError || !user) {
      return respond({ error: "Invalid session." }, 401);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let body: Record<string, unknown>;

    try {
      const parsed = await req.json();

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return respond({ error: "Invalid request body." }, 400);
      }

      body = parsed as Record<string, unknown>;
    } catch {
      return respond({ error: "Invalid JSON request." }, 400);
    }

    const promptText =
      typeof body.promptText === "string" ? body.promptText.trim() : "";

    const duration = Number(body.duration);
    const songPath =
      typeof body.songPath === "string" ? body.songPath : "";

    const ratioChoice = body.ratio;
    const lipSync = body.lipSync === true;
    const lyrics = typeof body.lyrics === "string" ? body.lyrics.trim() : "";
    if (lyrics.length > 2000) return respond({ error: "Lyrics must be 2,000 characters or fewer." }, 400);

    if (!promptText || promptText.length > 1000) {
      return respond({ error: "Please describe your video." }, 400);
    }

    if (![10, 15, 20, 30].includes(duration)) {
      return respond({ error: "Only 10, 15, 20 or 30 seconds are supported." }, 400);
    }

    if (ratioChoice !== "landscape" && ratioChoice !== "portrait") {
      return respond({ error: "Invalid video format." }, 400);
    }

    const requiredPrefix = `${user.id}/.lane_mv_clip_`;

    if (
      !songPath.startsWith(requiredPrefix) ||
      !songPath.endsWith(".mp3") ||
      songPath.includes("..")
    ) {
      return respond({ error: "Invalid song excerpt." }, 400);
    }

    const { data: audioFile, error: audioError } =
      await admin.storage.from("user-songs").download(songPath);

    if (audioError || !audioFile) {
      console.error("Audio download failed:", audioError);
      return respond({ error: "Song excerpt could not be found." }, 400);
    }

    if (audioFile.size < 512 || audioFile.size > 15 * 1024 * 1024) {
      return respond({ error: "Audio file must be under 15 MB." }, 400);
    }

    if (!["audio/mpeg", "audio/mp3"].includes(audioFile.type)) {
      return respond({ error: "The song excerpt must be an MP3 file." }, 400);
    }

    const { data: signedAudio, error: signedError } =
      await admin.storage
        .from("user-songs")
        .createSignedUrl(songPath, 3600);

    if (signedError || !signedAudio?.signedUrl) {
      console.error("Audio signing failed:", signedError);
      return respond({ error: "Could not prepare audio for Runway." }, 500);
    }

    const owner = isOwnerUser(user.id);
    const ownerUsdCost = duration * 0.20;
    const credits = owner ? ownerCreditsForUsd(ownerUsdCost) : VIDEO_PRICES[duration];
    const pendingTaskId = `pending-${crypto.randomUUID()}`;

    const { data: job, error: insertError } = await admin
      .from("video_generations")
      .insert({
        user_id: user.id,
        runway_task_id: pendingTaskId,
        prompt: promptText,
        model: "seedance2_5",
        duration,
        status: "SUBMITTING",
        credits_charged: credits,
      })
      .select("id")
      .single();

    if (insertError || !job?.id) {
      console.error("Job creation failed:", insertError);
      return respond({ error: "Could not create video job." }, 500);
    }

    const { data: debited, error: debitError } = await admin.rpc(
      "debit_video_credits",
      { p_job_id: job.id }
    );

    if (debitError || debited !== true) {
      await admin
        .from("video_generations")
        .delete()
        .eq("id", job.id)
        .eq("user_id", user.id);

      return respond(
        {
          error: "Not enough credits or credit deduction failed.",
          requiredCredits: credits,
        },
        402
      );
    }

    const runwayRatio =
      ratioChoice === "portrait" ? "480:854" : "854:480";

    const lyricsInstruction = lyrics
      ? ` Display these exact lyrics as large, high-contrast subtitles synchronized to the vocals. Do not paraphrase, translate, add, remove, or invent words. Exact lyrics: "${lyrics.replace(/\\s+/g, " ").replace(/"/g, "'")}"`
      : " Do not invent any lyrics or captions.";
    const videoPrompt = lipSync
      ? `${promptText} Show a visible singer or character performing the provided reference song. Attempt to synchronize mouth movements and facial expressions with the vocals.${lyricsInstruction} Avoid unrelated text, logos and watermarks.`
      : `${promptText} Create a music video guided by the provided reference song.${lyricsInstruction} Avoid unrelated text, logos and watermarks.`;

    let runwayResponse: Response;

    try {
      runwayResponse = await fetch(
        "https://api.dev.runwayml.com/v1/text_to_video",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${runwayKey}`,
            "Content-Type": "application/json",
            "X-Runway-Version": "2024-11-06",
          },
          body: JSON.stringify({
            model: "seedance2_5",
            promptText: videoPrompt,
            ratio: runwayRatio,
            duration,
            referenceAudio: [
              {
                type: "audio",
                uri: signedAudio.signedUrl,
              },
            ],
          }),
        }
      );
    } catch (error) {
      console.error("Runway connection failed:", error);

      const refunded = await refundCredits(admin, job.id);

      await admin
        .from("video_generations")
        .update({
          status: "FAILED",
          error_message: "Could not connect to Runway.",
          refunded,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("user_id", user.id);

      return respond({
        error: "Could not connect to Runway.",
        refunded,
      }, 502);
    }

    let runwayData: Record<string, unknown>;

    try {
      const parsed = await runwayResponse.json();

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Invalid Runway response.");
      }

      runwayData = parsed as Record<string, unknown>;
    } catch {
      runwayData = {};
    }

    if (!runwayResponse.ok || typeof runwayData.id !== "string") {
      const message =
        typeof runwayData.error === "string"
          ? runwayData.error
          : `Runway rejected the request (${runwayResponse.status}).`;

      const refunded = await refundCredits(admin, job.id);

      await admin
        .from("video_generations")
        .update({
          status: "FAILED",
          error_message: message.slice(0, 2000),
          refunded,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("user_id", user.id);

      return respond({ error: message, refunded }, 502);
    }

    const { error: updateError } = await admin
      .from("video_generations")
      .update({
        runway_task_id: runwayData.id,
        owner_provider_cost_usd: Number.isFinite(Number((runwayData as any)?.estimatedCost?.credits)) ? Number((runwayData as any).estimatedCost.credits) * 0.01 : null,
        status: "PENDING",
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .eq("user_id", user.id);

    if (updateError) {
      console.error("Could not save Runway task ID:", updateError);

      return respond({
        success: false,
        error: "Runway accepted the task, but its task ID could not be saved. Contact support.",
        taskId: runwayData.id,
      }, 500);
    }

    return respond({
      success: true,
      generationId: job.id,
      taskId: runwayData.id,
      model: "seedance2_5",
      duration,
      creditsUsed: credits,
      resolution: "480p",
    });

  } catch (error) {
    console.error("Unexpected music video error:", error);

    return respond({
      error: "Unexpected server error. Please try again.",
    }, 500);
  }
});
