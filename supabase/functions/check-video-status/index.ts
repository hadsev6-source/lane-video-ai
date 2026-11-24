
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "user-videos";
const MAX_VIDEO_SIZE = 50 * 1024 * 1024;
const SIGNED_URL_SECONDS = 3600;

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
  const usd = seconds * 0.20;
  const rate = Number(Deno.env.get("OWNER_USD_TO_EUR") || OWNER_DEFAULT_USD_TO_EUR);
  const { error } = await admin.from("owner_api_costs").upsert({
    user_id: userId, service: "music_video_generation", provider: "Runway", model: "seedance2_5",
    amount_usd: usd, usd_to_eur: rate, amount_eur: usd * rate,
    credits_charged: ownerCreditsForUsd(usd), generation_id: task.id, duration_seconds: seconds,
    metadata: { costSource: "published_rate_estimate", resolution: "480p", audioReference: true },
  }, { onConflict: "user_id,service,generation_id", ignoreDuplicates: true });
  if (error) console.error("Could not record owner music video API cost:", error);
}


function respond(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
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

async function failTask(
  admin: any,
  task: any,
  userId: string,
  taskId: string,
  message: string,
) {
  const refunded = await refundCredits(admin, task.id);

  const { error } = await admin
    .from("video_generations")
    .update({
      status: "FAILED",
      error_message: message.slice(0, 2000),
      refunded,
      updated_at: new Date().toISOString(),
    })
    .eq("id", task.id)
    .eq("user_id", userId);

  if (error) {
    console.error("Could not update failed video:", error);
    return respond({
      success: false,
      taskId,
      status: "FAILED",
      error: "Video failed, but its database record could not be updated.",
      refunded,
    }, 500);
  }

  return respond({
    success: false,
    taskId,
    status: "FAILED",
    error: message,
    refunded,
    refundMessage: refunded
      ? "Credits were refunded."
      : "Credit refund could not be confirmed. It will be retried.",
  });
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

    const taskId = body.taskId;

    if (
      typeof taskId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)
    ) {
      return respond({ error: "Invalid task ID." }, 400);
    }

    const { data: task, error: findError } = await admin
      .from("video_generations")
      .select("id, runway_task_id, storage_path, status, error_message, refunded, model, duration, credits_charged")
      .eq("runway_task_id", taskId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (findError) {
      console.error("Task lookup failed:", findError);
      return respond({ error: "Could not retrieve video task." }, 500);
    }

    if (!task) {
      return respond({ error: "Video task not found." }, 404);
    }

    // If the video is already saved, return a fresh private link.
    if (task.storage_path) {
      await recordMusicVideoOwnerCost(admin, user.id, task);
      const { data: signedFile, error: signedError } = await admin.storage
        .from(BUCKET)
        .createSignedUrl(task.storage_path, SIGNED_URL_SECONDS);

      if (signedError || !signedFile?.signedUrl) {
        console.error("Signed URL error:", signedError);
        return respond({
          error: "Video is saved, but its access link could not be created.",
        }, 500);
      }

      return respond({
        success: true,
        taskId,
        status: "SUCCEEDED",
        output: signedFile.signedUrl,
        storagePath: task.storage_path,
        message: "Video is already saved.",
      });
    }

    // Retry a refund if a previous refund attempt was unsuccessful.
    if (task.status === "FAILED" || task.status === "CANCELLED") {
      let refunded = task.refunded === true;

      if (!refunded) {
        refunded = await refundCredits(admin, task.id);

        if (refunded) {
          await admin
            .from("video_generations")
            .update({
              refunded: true,
              updated_at: new Date().toISOString(),
            })
            .eq("id", task.id)
            .eq("user_id", user.id);
        }
      }

      return respond({
        success: false,
        taskId,
        status: task.status,
        failure: task.error_message || task.status,
        refunded,
      });
    }

    // Get the latest task status from Runway.
    let runwayResponse: Response;

    try {
      runwayResponse = await fetch(
        `https://api.dev.runwayml.com/v1/tasks/${encodeURIComponent(taskId)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${runwayKey}`,
            "X-Runway-Version": "2024-11-06",
          },
        },
      );
    } catch (error) {
      console.error("Runway connection error:", error);
      return respond({ error: "Could not connect to Runway." }, 502);
    }

    let result: Record<string, unknown>;

    try {
      const data = await runwayResponse.json();

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Invalid Runway response.");
      }

      result = data as Record<string, unknown>;
    } catch {
      return respond({ error: "Invalid response from Runway." }, 502);
    }

    if (!runwayResponse.ok) {
      console.error("Runway status error:", result);
      return respond({ error: "Could not retrieve Runway task." }, 502);
    }

    const status =
      typeof result.status === "string" ? result.status : "UNKNOWN";

    // Failed or cancelled task: refund credits.
    if (status === "FAILED" || status === "CANCELLED") {
      const failure = result.failure ?? result.error ?? status;
      const errorMessage = String(
        typeof failure === "string" ? failure : JSON.stringify(failure),
      ).slice(0, 2000);

      return await failTask(
        admin,
        task,
        user.id,
        taskId,
        errorMessage,
      );
    }

    // Task is still processing.
    if (status !== "SUCCEEDED") {
      const { error } = await admin
        .from("video_generations")
        .update({
          status,
          updated_at: new Date().toISOString(),
        })
        .eq("id", task.id)
        .eq("user_id", user.id);

      if (error) {
        console.error("Status update failed:", error);
      }

      return respond({
        success: true,
        taskId,
        status,
        message: "Video generation is still processing.",
      });
    }

    // Extract the completed video URL.
    const output = Array.isArray(result.output)
      ? result.output[0]
      : result.output;

    if (typeof output !== "string") {
      return respond({
        error: "Runway completed the task but returned no video URL.",
      }, 502);
    }

    let outputUrl: URL;

    try {
      outputUrl = new URL(output);
    } catch {
      return respond({ error: "Runway returned an invalid video URL." }, 502);
    }

    if (outputUrl.protocol !== "https:") {
      return respond({ error: "Runway returned an invalid video URL." }, 502);
    }

    // Download the completed video.
    let videoResponse: Response;

    try {
      videoResponse = await fetch(outputUrl.toString());
    } catch (error) {
      console.error("Video download error:", error);
      return respond({
        error: "Could not download the video. Please try checking again.",
      }, 502);
    }

    if (!videoResponse.ok) {
      return respond({
        error: "Could not download the completed video. Please try again.",
      }, 502);
    }

    const contentLength = Number(
      videoResponse.headers.get("content-length") || 0,
    );

    if (contentLength > MAX_VIDEO_SIZE) {
      return await failTask(
        admin,
        task,
        user.id,
        taskId,
        "Video exceeds the 50 MB file limit. Credits have been refunded if the refund succeeded.",
      );
    }

    const videoBlob = await videoResponse.blob();

    if (videoBlob.size === 0 || videoBlob.size > MAX_VIDEO_SIZE) {
      return await failTask(
        admin,
        task,
        user.id,
        taskId,
        "Video is empty or exceeds the 50 MB file limit. Credits have been refunded if the refund succeeded.",
      );
    }

    const storagePath = `${user.id}/${taskId}.mp4`;

    // Save the video in the private Storage bucket.
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(storagePath, videoBlob, {
        contentType: "video/mp4",
        cacheControl: "3600",
        upsert: true,
      });

    if (uploadError) {
      console.error("Video upload failed:", uploadError);

      return await failTask(
        admin,
        task,
        user.id,
        taskId,
        `Video could not be saved: ${uploadError.message}`,
      );
    }

    // Save the permanent Storage path.
    const { error: updateError } = await admin
      .from("video_generations")
      .update({
        status: "SUCCEEDED",
        storage_path: storagePath,
        output_url: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", task.id)
      .eq("user_id", user.id);

    if (updateError) {
      console.error("Video database update failed:", updateError);

      await admin.storage.from(BUCKET).remove([storagePath]);

      return await failTask(
        admin,
        task,
        user.id,
        taskId,
        "Could not save the video record in the database.",
      );
    }

    // Record owner API cost after the completed video has been stored.
    await recordMusicVideoOwnerCost(admin, user.id, task);

    // Create a temporary private playback/download URL.
    const { data: signedFile, error: signedError } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_SECONDS);

    if (signedError || !signedFile?.signedUrl) {
      console.error("Signed URL error:", signedError);

      return respond({
        success: true,
        taskId,
        status: "SUCCEEDED",
        storagePath,
        output: null,
        warning: "Video is saved, but its playback link could not be created. Check again to get a new link.",
      });
    }

    return respond({
      success: true,
      taskId,
      status: "SUCCEEDED",
      output: signedFile.signedUrl,
      storagePath,
      message: "Video generated and saved successfully.",
    });

  } catch (error) {
    console.error("check-video-status error:", error);

    return respond({
      error: "Unexpected server error.",
    }, 500);
  }
});
