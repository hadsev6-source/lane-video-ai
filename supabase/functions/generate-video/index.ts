
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseBuffer } from "npm:music-metadata@11.9.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const VIDEO_PRICES: Record<number, number> = {
  5: 192,
  10: 303,
  15: 557,
  20: 743,
  30: 1114,
};
const LIP_SYNC_SURCHARGE = 100;

const OWNER_USER_ID = "dce2d514-964d-49be-b83d-45e6721b49a7";
const OWNER_CREDITS_PER_EUR = 140;
const OWNER_DEFAULT_USD_TO_EUR = 0.9168;

function isOwnerUser(userId: string): boolean {
  return userId === OWNER_USER_ID;
}

function ownerCreditsForUsd(usd: number): number {
  const configuredRate = Number(Deno.env.get("OWNER_USD_TO_EUR") || OWNER_DEFAULT_USD_TO_EUR);
  if (!Number.isFinite(configuredRate) || configuredRate <= 0 || !Number.isFinite(usd) || usd < 0) {
    throw new Error("Invalid owner API cost conversion configuration.");
  }
  return Math.max(1, Math.ceil(usd * configuredRate * OWNER_CREDITS_PER_EUR));
}

async function recordOwnerApiCost(admin: any, entry: {
  userId: string; service: string; provider: string; model: string;
  usd: number; credits: number; generationId?: string; durationSeconds?: number;
  metadata?: Record<string, unknown>;
}) {
  const exchangeRate = Number(Deno.env.get("OWNER_USD_TO_EUR") || OWNER_DEFAULT_USD_TO_EUR);
  const incomingSource = String(entry.metadata?.costSource || "");
  if (!["provider_billing_record", "provider_task_estimate", "published_rate_estimate"].includes(incomingSource)) {
    console.error("Owner API cost record rejected: missing or invalid cost source.");
    return;
  }
  if (!Number.isFinite(entry.usd) || entry.usd < 0 || !Number.isFinite(exchangeRate) || exchangeRate <= 0) {
    console.error("Owner API cost record rejected: invalid amount or exchange rate.");
    return;
  }
  if (entry.generationId) {
    const { data: existing, error: lookupError } = await admin.from("owner_api_costs")
      .select("metadata").eq("user_id", entry.userId).eq("service", entry.service)
      .eq("generation_id", entry.generationId).maybeSingle();
    if (lookupError) { console.error("Could not inspect existing owner API cost:", lookupError); return; }
    const existingSource = String(existing?.metadata?.costSource || "");
    if (existingSource === "provider_billing_record" && incomingSource !== "provider_billing_record") return;
  }
  const { error } = await admin.from("owner_api_costs").upsert({
    user_id: entry.userId, service: entry.service, provider: entry.provider, model: entry.model,
    amount_usd: entry.usd, usd_to_eur: exchangeRate, amount_eur: entry.usd * exchangeRate,
    credits_charged: entry.credits, generation_id: entry.generationId || null,
    duration_seconds: entry.durationSeconds ?? null, metadata: entry.metadata || {},
  }, { onConflict: "user_id,service,generation_id" });
  if (error) console.error("Could not record owner API cost:", error);
}

const WAVESPEED_SUBMIT_URL = "https://api.wavespeed.ai/api/v3/wavespeed-ai/infinitetalk-fast";
const WAVESPEED_RESULT_BASE = "https://api.wavespeed.ai/api/v3/predictions";

async function getWaveSpeedActualCost(apiKey: string, predictionId: string): Promise<number | null> {
  if (!predictionId) return null;
  try {
    const response = await fetch("https://api.wavespeed.ai/api/v3/billings/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prediction_uuids: [predictionId], page: 1, page_size: 10 }),
    });
    if (!response.ok) {
      console.warn("WaveSpeed billing lookup unavailable:", response.status);
      return null;
    }
    const payload = await response.json();
    const items = payload?.data?.items;
    if (!Array.isArray(items)) return null;
    const matched = items.filter((item: any) =>
      item?.prediction?.uuid === predictionId && Number.isFinite(Number(item?.price))
    );
    if (!matched.length) return null;
    return matched.reduce((sum: number, item: any) => sum + Number(item.price), 0);
  } catch (error) {
    console.warn("WaveSpeed billing lookup failed:", error);
    return null;
  }
}


const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";
const RUNWAY_VERSION = "2024-11-06";
const STORAGE_BUCKET = "generated-videos";
const SIGNED_URL_SECONDS = 60 * 60;

type JsonObject = Record<string, unknown>;

function runwayHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "X-Runway-Version": RUNWAY_VERSION,
  };
}

async function readJson(response: Response): Promise<JsonObject> {
  const value = await response.json();

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The provider returned an invalid response.");
  }

  return value as JsonObject;
}

function normalizedRunwayStatus(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "PENDING";
  return value.trim().toUpperCase();
}

async function refundJob(
  admin: ReturnType<typeof createClient>,
  generationId: string,
) {
  const { data, error } = await admin.rpc("refund_video_credits", {
    p_job_id: generationId,
  });

  if (error) {
    console.error("Video credit refund RPC failed:", error);
    return { refunded: false, error: error.message };
  }

  return { refunded: data === true, error: null };
}

async function createVideoSignedUrl(
  admin: ReturnType<typeof createClient>,
  storagePath: string,
) {
  const { data, error } = await admin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_SECONDS);

  if (error || !data?.signedUrl) {
    console.error("Could not create video signed URL:", error);
    return null;
  }

  return data.signedUrl;
}

// Move the MP4 moov atom before media data so browsers can start playback
// without downloading the entire file first. No re-encoding is performed.
function fastStartMp4(input: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(input);
  const view = new DataView(input);
  const readAtom = (offset: number, limit: number) => {
    if (offset + 8 > limit) throw new Error("Truncated MP4 atom header.");
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > limit) throw new Error("Truncated extended MP4 atom.");
      const largeSize = view.getBigUint64(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("MP4 atom is too large.");
      size = Number(largeSize);
      headerSize = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    if (size < headerSize || offset + size > limit) throw new Error("Invalid MP4 atom size.");
    return { offset, size, type, headerSize, end: offset + size };
  };

  try {
    const top: ReturnType<typeof readAtom>[] = [];
    for (let offset = 0; offset < bytes.length;) {
      const atom = readAtom(offset, bytes.length);
      top.push(atom);
      offset = atom.end;
    }
    const moov = top.find((atom) => atom.type === "moov");
    const mdat = top.find((atom) => atom.type === "mdat");
    if (!moov || !mdat || moov.offset < mdat.offset) return input;

    const containers = new Set([
      "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "mvex",
      "udta", "tref", "ipro", "sinf", "schi", "meco", "mere",
    ]);

    const adjustOffsets = (start: number, end: number, parentType: string) => {
      let offset = start;
      if (parentType === "meta") offset += 4; // FullBox header before child atoms.
      while (offset + 8 <= end) {
        const atom = readAtom(offset, end);
        if (atom.type === "stco" || atom.type === "co64") {
          const countOffset = atom.offset + atom.headerSize + 4;
          if (countOffset + 4 > atom.end) throw new Error("Invalid MP4 chunk offset table.");
          const count = view.getUint32(countOffset);
          const entrySize = atom.type === "stco" ? 4 : 8;
          const entriesStart = countOffset + 4;
          if (entriesStart + count * entrySize > atom.end) throw new Error("Truncated MP4 chunk offsets.");
          for (let i = 0; i < count; i++) {
            const entry = entriesStart + i * entrySize;
            if (entrySize === 4) {
              const value = view.getUint32(entry);
              if (value >= mdat.offset) {
                const updated = value + moov.size;
                if (updated > 0xffffffff) throw new Error("MP4 chunk offset requires a 64-bit table.");
                view.setUint32(entry, updated);
              }
            } else {
              const value = view.getBigUint64(entry);
              if (value >= BigInt(mdat.offset)) view.setBigUint64(entry, value + BigInt(moov.size));
            }
          }
        } else if (containers.has(atom.type) || atom.type === "meta") {
          adjustOffsets(atom.offset + atom.headerSize, atom.end, atom.type);
        }
        offset = atom.end;
      }
      if (offset !== end) throw new Error("Invalid MP4 child atom alignment.");
    };

    adjustOffsets(moov.offset + moov.headerSize, moov.end, "moov");
    const output = new Uint8Array(bytes.length);
    const beforeMdat = bytes.subarray(0, mdat.offset);
    const moovBytes = bytes.subarray(moov.offset, moov.end);
    const withoutMoov = new Uint8Array(bytes.length - moov.size);
    withoutMoov.set(bytes.subarray(0, moov.offset), 0);
    withoutMoov.set(bytes.subarray(moov.end), moov.offset);
    output.set(withoutMoov.subarray(0, mdat.offset), 0);
    output.set(moovBytes, mdat.offset);
    output.set(withoutMoov.subarray(mdat.offset), mdat.offset + moov.size);
    return output.buffer;
  } catch (error) {
    console.error("Could not optimize MP4 for fast start; storing original file:", error);
    return input;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      return json({ error: "Please sign in first." }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
      Deno.env.get("MY_SERVICE_ROLE_KEY");
    const runwayKey = Deno.env.get("RUNWAY_API_KEY");
    const wavespeedKey = Deno.env.get("WAVESPEED_API_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey) {
      console.error("Missing required server configuration.");
      return json({ error: "Server configuration is incomplete." }, 500);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return json({ error: "Invalid or expired session." }, 401);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    let body: JsonObject = {};
    let lipSyncImage: File | null = null;
    let lipSyncAudio: File | null = null;
    const contentType = req.headers.get("content-type") || "";
    try {
      if (contentType.toLowerCase().includes("multipart/form-data")) {
        const form = await req.formData();
        lipSyncImage = form.get("image") instanceof File ? form.get("image") as File : null;
        lipSyncAudio = form.get("audio") instanceof File ? form.get("audio") as File : null;
        body = {
          action: "start-lipsync",
          videoDurationSeconds: form.get("videoDurationSeconds"),
        };
      } else {
        const parsed = await req.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return json({ error: "Invalid request body." }, 400);
        }
        body = parsed as JsonObject;
      }
    } catch {
      return json({ error: "Invalid request body." }, 400);
    }

    const action = typeof body.action === "string" ? body.action : "start";

    // Check Runway API key without creating a task or charging credits.
    if (action === "check-key") {
      if (!runwayKey) return json({ success: false, keyAccepted: false, message: "Runway API key is not configured." }, 500);
      try {
        const response = await fetch(`${RUNWAY_BASE}/organization`, {
          method: "GET",
          headers: runwayHeaders(runwayKey),
        });

        if (!response.ok) {
          const details = await response.text();
          console.error(
            "Runway key check failed:",
            response.status,
            details.slice(0, 1000),
          );

          return json({
            success: false,
            keyAccepted: false,
            httpStatus: response.status,
            message: response.status === 401
              ? "Runway rejected the API key."
              : `Runway returned HTTP ${response.status}.`,
          });
        }

        const organization = await readJson(response);
        return json({
          success: true,
          keyAccepted: true,
          message: "Runway API key is valid and active.",
          creditBalance: typeof organization.creditBalance === "number"
            ? organization.creditBalance
            : null,
        });
      } catch (error) {
        console.error("Runway key check error:", error);
        return json({
          success: false,
          keyAccepted: false,
          message: "Could not complete the Runway API key check.",
        }, 502);
      }
    }

    // Check the status of a video job owned by the signed-in user.
    if (action === "status") {
      const generationId =
        typeof body.generationId === "string" ? body.generationId.trim() : "";

      if (!generationId) {
        return json({ error: "generationId is required." }, 400);
      }

      const { data: job, error: jobError } = await admin
        .from("video_generations")
        .select(
          "id, user_id, runway_task_id, model, status, storage_path, refunded, error_message, duration, credits_charged, owner_billable_seconds",
        )
        .eq("id", generationId)
        .eq("user_id", user.id)
        .maybeSingle();

      if (jobError || !job) {
        console.error("Video job lookup failed:", jobError);
        return json({ error: "Video job not found." }, 404);
      }

      if (job.storage_path) {
        if (isOwnerUser(user.id)) {
          if (job.model === "infinitetalk-fast") {
            const billableSeconds = Number(job.owner_billable_seconds || 0);
            const actual = await getWaveSpeedActualCost(wavespeedKey || "", String(job.runway_task_id || ""));
            await recordOwnerApiCost(admin, {
              userId: user.id, service: "video_lipsync", provider: "WaveSpeed",
              model: "wavespeed-ai/infinitetalk-fast",
              usd: actual ?? billableSeconds * 0.015,
              credits: ownerCreditsForUsd(actual ?? billableSeconds * 0.015), generationId,
              durationSeconds: billableSeconds,
              metadata: { costSource: actual === null ? "published_rate_estimate" : "provider_billing_record" },
            });
          } else {
            const completedDuration = Number(job.duration || 0);
            const completedModel = String(job.model || "");
            await recordOwnerApiCost(admin, {
              userId: user.id, service: "video_generation", provider: "Runway",
              model: completedModel,
              usd: Number(job.owner_provider_cost_usd ?? (completedDuration * (completedModel === "gen4.5" ? 0.12 : 0.20))),
              credits: ownerCreditsForUsd(completedDuration * (completedModel === "gen4.5" ? 0.12 : 0.20)), generationId,
              durationSeconds: completedDuration,
              metadata: { costSource: job.owner_provider_cost_usd == null ? "published_rate_estimate" : "provider_task_estimate" },
            });
          }
        }
        const videoUrl = await createVideoSignedUrl(admin, job.storage_path);

        if (!videoUrl) {
          return json({
            error: "Video is saved, but a download link could not be created.",
            generationId,
            status: "SUCCEEDED",
          }, 500);
        }

        return json({
          success: true,
          generationId,
          status: "SUCCEEDED",
          storagePath: job.storage_path,
          videoUrl,
        });
      }

      // Lip Sync jobs use WaveSpeed InfiniteTalk Fast; standard jobs continue through Runway.
      if (job.model === "infinitetalk-fast") {
        if (!wavespeedKey) return json({ error: "WaveSpeed is not configured on the server." }, 500);
        const predictionId = typeof job.runway_task_id === "string" ? job.runway_task_id : "";
        if (!predictionId || predictionId.startsWith("pending-")) {
          return json({ success: true, generationId, status: job.status || "SUBMITTING" });
        }
        let waveResponse: Response;
        try {
          waveResponse = await fetch(`${WAVESPEED_RESULT_BASE}/${encodeURIComponent(predictionId)}/result`, {
            headers: { Authorization: `Bearer ${wavespeedKey}` },
          });
        } catch (error) {
          console.error("WaveSpeed status connection error:", error);
          return json({ error: "Could not contact WaveSpeed to check Lip Sync." }, 502);
        }
        let waveEnvelope: JsonObject;
        try { waveEnvelope = await readJson(waveResponse); }
        catch { return json({ error: "WaveSpeed returned an unreadable status response." }, 502); }
        if (!waveResponse.ok) return json({ error: "WaveSpeed could not return Lip Sync status.", providerStatus: waveResponse.status }, 502);
        const waveTask = (waveEnvelope.data && typeof waveEnvelope.data === "object")
          ? waveEnvelope.data as JsonObject : waveEnvelope;
        const waveStatus = typeof waveTask.status === "string" ? waveTask.status.toLowerCase() : "processing";
        if (waveStatus === "completed") {
          const outputs = Array.isArray(waveTask.outputs) ? waveTask.outputs : [];
          const remoteVideoUrl = typeof outputs[0] === "string" ? outputs[0] : "";
          if (!remoteVideoUrl.startsWith("https://")) return json({ error: "WaveSpeed completed without a usable video URL." }, 502);
          const videoResponse = await fetch(remoteVideoUrl);
          if (!videoResponse.ok) return json({ error: "Lip Sync is ready but could not be downloaded yet." }, 502);
          const downloadedVideo = await videoResponse.arrayBuffer();
          const videoBytes = fastStartMp4(downloadedVideo);
          const storagePath = `${user.id}/${generationId}.mp4`;
          const { error: uploadError } = await admin.storage.from(STORAGE_BUCKET).upload(storagePath, videoBytes, {
            contentType: "video/mp4", upsert: true,
          });
          if (uploadError) {
            console.error("Lip Sync video storage upload failed:", uploadError);
            return json({ error: "Lip Sync completed, but saving the video failed." }, 500);
          }
          const { error: saveError } = await admin.from("video_generations").update({
            status: "SUCCEEDED", storage_path: storagePath, output_url: null,
            error_message: null, updated_at: new Date().toISOString(),
          }).eq("id", generationId).eq("user_id", user.id);
          if (saveError) return json({ error: "Video saved but its database record could not be updated." }, 500);
          if (isOwnerUser(user.id)) {
            const billableSeconds = Number(job.owner_billable_seconds || 0);
            const estimate = billableSeconds * 0.015;
            const actual = await getWaveSpeedActualCost(wavespeedKey, predictionId);
            await recordOwnerApiCost(admin, {
              userId: user.id, service: "video_lipsync", provider: "WaveSpeed",
              model: "wavespeed-ai/infinitetalk-fast", usd: actual ?? estimate,
              credits: ownerCreditsForUsd(actual ?? estimate), generationId,
              durationSeconds: billableSeconds,
              metadata: { selectedVideoDuration: job.duration, costSource: actual === null ? "published_rate_estimate" : "provider_billing_record" },
            });
          }
          const videoUrl = await createVideoSignedUrl(admin, storagePath);
          return json({ success: true, generationId, status: "SUCCEEDED", storagePath, ...(videoUrl ? { videoUrl } : {}) });
        }
        if (["failed", "cancelled", "timeout", "deleted"].includes(waveStatus)) {
          const providerFailure = typeof waveTask.error === "string" && waveTask.error.trim()
            ? waveTask.error.trim() : `WaveSpeed task ${waveStatus}.`;
          const refund = job.refunded ? { refunded: false, error: null } : await refundJob(admin, generationId);
          await admin.from("video_generations").update({
            status: waveStatus === "cancelled" ? "CANCELED" : "FAILED",
            error_message: providerFailure, ...(refund.refunded ? { refunded: true } : {}),
            updated_at: new Date().toISOString(),
          }).eq("id", generationId).eq("user_id", user.id);
          return json({ success: true, generationId, status: waveStatus === "cancelled" ? "CANCELED" : "FAILED",
            refunded: job.refunded === true || refund.refunded, refundPending: !job.refunded && !refund.refunded,
            error: providerFailure });
        }
        const normalized = waveStatus === "created" ? "PENDING" : waveStatus.toUpperCase();
        await admin.from("video_generations").update({ status: normalized, updated_at: new Date().toISOString() })
          .eq("id", generationId).eq("user_id", user.id).neq("status", "SUCCEEDED");
        return json({ success: true, generationId, status: normalized, message: "Lip Sync is still processing." });
      }

      const taskId =
        typeof job.runway_task_id === "string" ? job.runway_task_id : "";

      if (!taskId || taskId.startsWith("pending-")) {
        return json({
          success: true,
          generationId,
          status: job.status || "SUBMITTING",
          message: "The video task is being submitted.",
        });
      }

      let taskResponse: Response;

      try {
        taskResponse = await fetch(
          `${RUNWAY_BASE}/tasks/${encodeURIComponent(taskId)}`,
          { method: "GET", headers: runwayHeaders(runwayKey) },
        );
      } catch (error) {
        console.error("Runway status connection error:", error);
        return json({
          error: "Could not contact Runway to check the task.",
        }, 502);
      }

      let task: JsonObject;

      try {
        task = await readJson(taskResponse);
      } catch (error) {
        console.error("Invalid Runway status response:", error);
        return json({
          error: "Runway returned an unreadable task status.",
        }, 502);
      }

      if (!taskResponse.ok) {
        console.error("Runway status request failed:", taskResponse.status, task);
        return json({
          error: "Runway could not return the task status.",
          providerStatus: taskResponse.status,
        }, 502);
      }

      const status = normalizedRunwayStatus(task.status);

      // Save the finished video to Supabase Storage.
      if (status === "SUCCEEDED") {
        const outputs = Array.isArray(task.output) ? task.output : [];
        const remoteVideoUrl =
          typeof outputs[0] === "string" ? outputs[0] : "";

        if (!remoteVideoUrl.startsWith("https://")) {
          console.error("Runway succeeded without a usable output URL.");
          return json({
            error: "Runway completed the task but returned no usable video URL.",
          }, 502);
        }

        let videoResponse: Response;

        try {
          videoResponse = await fetch(remoteVideoUrl);
        } catch (error) {
          console.error("Video download connection error:", error);
          return json({
            error: "The video is ready, but could not be downloaded from Runway yet.",
          }, 502);
        }

        if (!videoResponse.ok) {
          console.error("Video download failed:", videoResponse.status);
          return json({
            error: "The video is ready, but could not be downloaded from Runway yet.",
          }, 502);
        }

        const contentType =
          videoResponse.headers.get("content-type") || "video/mp4";

        if (
          !contentType.toLowerCase().includes("video") &&
          !contentType.toLowerCase().includes("octet-stream")
        ) {
          console.error("Unexpected video content type:", contentType);
          return json({
            error: "Runway returned an unexpected file type.",
          }, 502);
        }

        const downloadedVideo = await videoResponse.arrayBuffer();
        const videoBytes = fastStartMp4(downloadedVideo);
        const storagePath = `${user.id}/${generationId}.mp4`;

        const { error: uploadError } = await admin.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, videoBytes, {
            contentType: "video/mp4",
            upsert: true,
          });

        if (uploadError) {
          console.error("Supabase video upload failed:", uploadError);
          return json({
            error: "The video is ready, but saving it to storage failed. Please retry.",
          }, 500);
        }

        const { error: saveError } = await admin
          .from("video_generations")
          .update({
            status: "SUCCEEDED",
            storage_path: storagePath,
            output_url: null,
            error_message: null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", generationId)
          .eq("user_id", user.id);

        if (saveError) {
          console.error("Could not save completed video record:", saveError);
          return json({
            error: "The video was uploaded, but its database record could not be updated. Please retry.",
          }, 500);
        }

        if (isOwnerUser(user.id)) {
          const completedDuration = Number(job.duration || 0);
          const completedModel = String(job.model || "");
          const rate = completedModel === "gen4.5" ? 0.12 : 0.20;
          await recordOwnerApiCost(admin, {
            userId: user.id, service: "video_generation", provider: "Runway",
            model: completedModel, usd: Number(job.owner_provider_cost_usd ?? (completedDuration * rate)),
            credits: ownerCreditsForUsd(completedDuration * rate), generationId,
            durationSeconds: completedDuration,
            metadata: { costSource: job.owner_provider_cost_usd == null ? "published_rate_estimate" : "provider_task_estimate" },
          });
        }

        const videoUrl = await createVideoSignedUrl(admin, storagePath);

        return json({
          success: true,
          generationId,
          status: "SUCCEEDED",
          storagePath,
          ...(videoUrl ? { videoUrl } : {
            message: "Video saved. Request status again to create a download link.",
          }),
        });
      }

      // Refund credits when Runway reports a failed or canceled task.
      if (status === "FAILED" || status === "CANCELED") {
        const providerFailure =
          typeof task.failure === "string" && task.failure.trim()
            ? task.failure.trim()
            : `Runway task ${status.toLowerCase()}.`;

        const refund = job.refunded
          ? { refunded: false, error: null }
          : await refundJob(admin, generationId);

        const { error: statusSaveError } = await admin
          .from("video_generations")
          .update({
            status,
            error_message: providerFailure,
            ...(refund.refunded ? { refunded: true } : {}),
            updated_at: new Date().toISOString(),
          })
          .eq("id", generationId)
          .eq("user_id", user.id);

        if (statusSaveError) {
          console.error("Could not save failed video status:", statusSaveError);
        }

        return json({
          success: true,
          generationId,
          status,
          refunded: job.refunded === true || refund.refunded,
          refundPending: !job.refunded && !refund.refunded,
          message: "Video generation did not complete.",
        });
      }

      // Do not let a late processing response overwrite a completed job.
      if (job.status !== "SUCCEEDED" && job.status !== "COMPLETED") {
        const { error: statusSaveError } = await admin
          .from("video_generations")
          .update({
            status,
            updated_at: new Date().toISOString(),
          })
          .eq("id", generationId)
          .eq("user_id", user.id)
          .neq("status", "SUCCEEDED");

        if (statusSaveError) {
          console.error("Could not update processing status:", statusSaveError);
        }
      }

      return json({
        success: true,
        generationId,
        status,
        message: "Video is still processing.",
      });
    }

    if (action !== "start" && action !== "start-lipsync") {
      return json({ error: "Unsupported action. Use start, status or check-key." }, 400);
    }

    if (action === "start-lipsync") {
      if (!wavespeedKey) return json({ error: "WaveSpeed API key is not configured." }, 500);
      if (!lipSyncImage || !lipSyncAudio) return json({ error: "Please upload both a photo and an audio file." }, 400);
      if (lipSyncImage.size <= 0 || lipSyncImage.size > 10 * 1024 * 1024) return json({ error: "Photo must be no larger than 10 MB." }, 400);
      if (lipSyncAudio.size <= 0 || lipSyncAudio.size > 25 * 1024 * 1024) return json({ error: "Audio must be no larger than 25 MB." }, 400);
      const imageType = lipSyncImage.type.toLowerCase();
      const audioType = lipSyncAudio.type.toLowerCase();
      if (!["image/jpeg", "image/png", "image/webp"].includes(imageType)) return json({ error: "Photo must be JPG, PNG or WEBP." }, 400);
      if (!audioType.startsWith("audio/")) return json({ error: "Please upload a supported audio file." }, 400);
      const videoDuration = Number(body.videoDurationSeconds);
      if (!Number.isInteger(videoDuration) || !VIDEO_PRICES[videoDuration]) {
        return json({ error: "Video duration must be 5, 10, 15, 20 or 30 seconds." }, 400);
      }

      // Read the uploaded audio itself on the server. The browser-supplied duration
      // is only advisory and is never used to determine the billable duration.
      const audioBytes = new Uint8Array(await lipSyncAudio.arrayBuffer());
      let audioSeconds: number;
      try {
        const audioMetadata = await parseBuffer(audioBytes, { mimeType: audioType });
        audioSeconds = Number(audioMetadata.format.duration);
      } catch (metadataError) {
        console.error("Could not inspect uploaded Lip Sync audio:", metadataError);
        return json({ error: "Could not verify the audio duration. Please upload a supported MP3, WAV, M4A, AAC, OGG or WEBM file." }, 400);
      }
      if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) {
        return json({ error: "Could not verify a valid audio duration." }, 400);
      }
      if (![5, 10, 15, 20, 30].includes(videoDuration)) {
        return json({ error: "Lip Sync is available for 5, 10, 15, 20 and 30-second videos." }, 400);
      }
      if (audioSeconds > videoDuration) {
        return json({ error: `Audio must be no longer than the selected ${videoDuration}-second video.` }, 400);
      }

      const owner = isOwnerUser(user.id);
      const billableAudioSeconds = Math.min(600, Math.max(3, Math.ceil(audioSeconds)));
      const ownerUsdCost = billableAudioSeconds * 0.015;
      const credits = owner ? ownerCreditsForUsd(ownerUsdCost) : VIDEO_PRICES[videoDuration] + LIP_SYNC_SURCHARGE;
      const ext = (file: File, fallback: string) => {
        const nameExt = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || fallback;
        return nameExt.slice(0, 8) || fallback;
      };
      const imagePath = `${user.id}/lipsync-inputs/${crypto.randomUUID()}-image.${ext(lipSyncImage, "jpg")}`;
      const audioPath = `${user.id}/lipsync-inputs/${crypto.randomUUID()}-audio.${ext(lipSyncAudio, "mp3")}`;
      const { error: imageUploadError } = await admin.storage.from(STORAGE_BUCKET).upload(imagePath, await lipSyncImage.arrayBuffer(), { contentType: imageType, upsert: false });
      if (imageUploadError) return json({ error: "Could not securely upload the photo." }, 500);
      const { error: audioUploadError } = await admin.storage.from(STORAGE_BUCKET).upload(audioPath, await lipSyncAudio.arrayBuffer(), { contentType: audioType, upsert: false });
      if (audioUploadError) {
        await admin.storage.from(STORAGE_BUCKET).remove([imagePath]);
        return json({ error: "Could not securely upload the audio." }, 500);
      }
      const { data: imageSigned, error: imageSignedError } = await admin.storage.from(STORAGE_BUCKET).createSignedUrl(imagePath, 60 * 60 * 24);
      const { data: audioSigned, error: audioSignedError } = await admin.storage.from(STORAGE_BUCKET).createSignedUrl(audioPath, 60 * 60 * 24);
      if (imageSignedError || audioSignedError || !imageSigned?.signedUrl || !audioSigned?.signedUrl) {
        await admin.storage.from(STORAGE_BUCKET).remove([imagePath, audioPath]);
        return json({ error: "Could not prepare secure media links for Lip Sync." }, 500);
      }
      const { data: job, error: insertError } = await admin.from("video_generations").insert({
        user_id: user.id, runway_task_id: `pending-${crypto.randomUUID()}`, prompt: "Lip Sync photo animation",
        model: "infinitetalk-fast", duration: videoDuration, owner_billable_seconds: billableAudioSeconds,
        status: "SUBMITTING", credits_charged: credits,
      }).select("id").single();
      if (insertError || !job) {
        await admin.storage.from(STORAGE_BUCKET).remove([imagePath, audioPath]);
        console.error("Could not create Lip Sync job:", insertError);
        return json({ error: "Could not create the Lip Sync job." }, 500);
      }
      const generationId = job.id as string;
      const { data: debitResult, error: debitError } = await admin.rpc("debit_video_credits", { p_job_id: generationId });
      if (debitError || debitResult !== true) {
        await admin.from("video_generations").delete().eq("id", generationId).eq("user_id", user.id);
        await admin.storage.from(STORAGE_BUCKET).remove([imagePath, audioPath]);
        return json({ error: "There are not enough available credits for Lip Sync.", requiredCredits: credits }, 402);
      }
      let submitResponse: Response;
      try {
        submitResponse = await fetch(WAVESPEED_SUBMIT_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${wavespeedKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ image: imageSigned.signedUrl, audio: audioSigned.signedUrl }),
        });
      } catch (error) {
        console.error("WaveSpeed submit connection error:", error);
        await admin.from("video_generations").update({ status: "SUBMISSION_UNKNOWN", error_message: "WaveSpeed submission outcome is unknown; check provider history before retrying.", updated_at: new Date().toISOString() }).eq("id", generationId);
        return json({ error: "Connection to WaveSpeed was interrupted. The task may have been accepted; do not submit again until checked.", generationId, refunded: false, refundPending: true }, 502);
      }
      let submitEnvelope: JsonObject;
      try { submitEnvelope = await readJson(submitResponse); }
      catch {
        if (submitResponse.ok) {
          await admin.from("video_generations").update({ status: "SUBMISSION_UNKNOWN", error_message: "WaveSpeed returned an unreadable response; submission may have been accepted.", updated_at: new Date().toISOString() }).eq("id", generationId);
          return json({ error: "WaveSpeed response was unreadable. Check provider history before retrying.", generationId, refunded: false, refundPending: true }, 502);
        }
        const refund = await refundJob(admin, generationId);
        await admin.from("video_generations").update({ status: "FAILED", error_message: "WaveSpeed rejected the request.", ...(refund.refunded ? { refunded: true } : {}), updated_at: new Date().toISOString() }).eq("id", generationId);
        return json({ error: "WaveSpeed could not start Lip Sync.", refunded: refund.refunded, refundPending: !refund.refunded, generationId }, 502);
      }
      const task = submitEnvelope.data && typeof submitEnvelope.data === "object" ? submitEnvelope.data as JsonObject : submitEnvelope;
      const predictionId = typeof task.id === "string" ? task.id.trim() : "";
      if (!submitResponse.ok || !predictionId) {
        const refund = await refundJob(admin, generationId);
        const providerError = typeof task.error === "string" ? task.error : "WaveSpeed rejected the Lip Sync request.";
        await admin.from("video_generations").update({ status: "FAILED", error_message: providerError, ...(refund.refunded ? { refunded: true } : {}), updated_at: new Date().toISOString() }).eq("id", generationId);
        return json({ error: "WaveSpeed could not start Lip Sync: " + providerError, refunded: refund.refunded, refundPending: !refund.refunded, generationId }, 502);
      }
      const providerStatus = typeof task.status === "string" ? task.status.toUpperCase() : "PENDING";
      const { error: taskSaveError } = await admin.from("video_generations").update({ runway_task_id: predictionId, status: providerStatus, updated_at: new Date().toISOString() }).eq("id", generationId).eq("user_id", user.id);
      if (taskSaveError) console.error("Could not save WaveSpeed prediction ID:", taskSaveError);
      return json({ success: true, generationId, taskId: predictionId, status: providerStatus, model: "infinitetalk-fast", duration: videoDuration, creditsUsed: credits, message: "Lip Sync task started." });
    }

    // Validate the standard video generation request.
    if (!runwayKey) return json({ error: "Runway API key is not configured." }, 500);
    const promptText =
      typeof body.promptText === "string" ? body.promptText.trim() : "";
    const duration = Number(body.duration ?? 5);
    const requestedRatio =
      typeof body.ratio === "string" ? body.ratio : "1280:720";

    if (promptText.length < 3 || promptText.length > 1000) {
      return json({
        error: "Prompt must contain 3-1000 characters.",
      }, 400);
    }

    if (!Number.isInteger(duration) || !VIDEO_PRICES[duration]) {
      return json({
        error: "Duration must be 5, 10, 15, 20 or 30 seconds.",
      }, 400);
    }

    const validRatios = ["1280:720", "720:1280", "854:480", "480:854"];

    if (!validRatios.includes(requestedRatio)) {
      return json({
        error: "Choose landscape or portrait video format.",
      }, 400);
    }

    // Automatic model selection:
    // 5s and 10s = Gen-4.5
    // 15s, 20s and 30s = Seedance 2.5
    const model = duration <= 10 ? "gen4.5" : "seedance2_5";

    const isPortrait =
      requestedRatio === "720:1280" || requestedRatio === "480:854";

    // Normalize aspect ratio for the selected model.
    const ratio = model === "seedance2_5"
      ? (isPortrait ? "480:854" : "854:480")
      : (isPortrait ? "720:1280" : "1280:720");

    const owner = isOwnerUser(user.id);
    const ownerUsdCost = duration * (model === "gen4.5" ? 0.12 : 0.20);
    const credits = owner ? ownerCreditsForUsd(ownerUsdCost) : VIDEO_PRICES[duration];

    // Create the job before charging credits.
    const { data: job, error: insertError } = await admin
      .from("video_generations")
      .insert({
        user_id: user.id,
        runway_task_id: `pending-${crypto.randomUUID()}`,
        prompt: promptText,
        model,
        duration,
        status: "SUBMITTING",
        credits_charged: credits,
      })
      .select("id")
      .single();

    if (insertError || !job) {
      console.error("Could not create video job:", insertError);
      return json({
        error: "Could not create the video job.",
      }, 500);
    }

    const generationId = job.id as string;

    // Charge credits once using the SQL function.
    const { data: debitResult, error: debitError } = await admin.rpc(
      "debit_video_credits",
      { p_job_id: generationId },
    );

    if (debitError || debitResult !== true) {
      console.error("Video credit deduction failed:", debitError, debitResult);

      await admin
        .from("video_generations")
        .delete()
        .eq("id", generationId)
        .eq("user_id", user.id);

      return json({
        error: "There are not enough available credits for this video.",
        requiredCredits: credits,
      }, 402);
    }

    // Submit the video task to Runway.
    let providerResponse: Response;

    try {
      providerResponse = await fetch(`${RUNWAY_BASE}/text_to_video`, {
        method: "POST",
        headers: runwayHeaders(runwayKey),
        body: JSON.stringify({
          model,
          promptText,
          ratio,
          duration,
        }),
      });
    } catch (error) {
      console.error("Runway connection error:", error);

      // The request may have reached Runway despite the connection failure.
      // Do not refund automatically when task acceptance is uncertain.
      const message =
        "The connection to Runway was interrupted. The submission needs checking before credits can be refunded.";

      await admin
        .from("video_generations")
        .update({
          status: "SUBMISSION_UNKNOWN",
          error_message: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", generationId)
        .eq("user_id", user.id);

      return json({
        error: message,
        refunded: false,
        refundPending: true,
        generationId,
      }, 502);
    }

    let providerData: JsonObject;

    try {
      providerData = await readJson(providerResponse);
    } catch (error) {
      console.error(
        "Invalid Runway create-task response:",
        providerResponse.status,
        error,
      );

      const message = "Runway returned an invalid response.";

      // If HTTP succeeded, Runway may have accepted the task.
      // Keep the charge pending manual recovery.
      if (providerResponse.ok) {
        await admin
          .from("video_generations")
          .update({
            status: "SUBMISSION_UNKNOWN",
            error_message: message,
            updated_at: new Date().toISOString(),
          })
          .eq("id", generationId)
          .eq("user_id", user.id);

        return json({
          error: message,
          refunded: false,
          refundPending: true,
          generationId,
        }, 502);
      }

      const refund = await refundJob(admin, generationId);

      await admin
        .from("video_generations")
        .update({
          status: "FAILED",
          error_message: message,
          ...(refund.refunded ? { refunded: true } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", generationId)
        .eq("user_id", user.id);

      return json({
        error: message,
        refunded: refund.refunded,
        refundPending: !refund.refunded,
        generationId,
      }, 502);
    }

    if (
      !providerResponse.ok ||
      typeof providerData.id !== "string" ||
      !providerData.id.trim()
    ) {
      console.error(
        "Runway rejected the request:",
        providerResponse.status,
        providerData,
      );

      const refund = await refundJob(admin, generationId);

      const providerMessage =
        typeof providerData.error === "string"
          ? providerData.error
          : "Runway could not start video generation.";

      await admin
        .from("video_generations")
        .update({
          status: "FAILED",
          error_message: providerMessage,
          ...(refund.refunded ? { refunded: true } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq("id", generationId)
        .eq("user_id", user.id);

      return json({
        error: "Runway could not start video generation.",
        refunded: refund.refunded,
        refundPending: !refund.refunded,
        generationId,
      }, 502);
    }

    const taskId = providerData.id.trim();
    const taskStatus = normalizedRunwayStatus(providerData.status);

    // Save the Runway task ID. Retry once for transient database errors.
    let taskSaveError: unknown = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await admin
        .from("video_generations")
        .update({
          runway_task_id: taskId,
          owner_provider_cost_usd: Number.isFinite(Number(providerData.estimatedCost?.credits)) ? Number(providerData.estimatedCost.credits) * 0.01 : null,
          status: taskStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", generationId)
        .eq("user_id", user.id);

      if (!error) {
        taskSaveError = null;
        break;
      }

      taskSaveError = error;

      console.error(
        `Could not save Runway task ID (attempt ${attempt + 1}):`,
        error,
      );
    }

    if (taskSaveError) {
      // Do not refund: Runway accepted the task and may still generate it.
      return json({
        success: true,
        generationId,
        taskId,
        status: taskStatus,
        model,
        duration,
        ratio,
        creditsUsed: credits,
        warning:
          "Runway accepted the video, but the task ID could not be saved. Contact support with this generation ID.",
      });
    }

    return json({
      success: true,
      generationId,
      taskId,
      status: taskStatus,
      model,
      duration,
      ratio,
      creditsUsed: credits,
      message: "Video task started successfully.",
    });
  } catch (error) {
    console.error("generate-video unexpected error:", error);

    return json({
      error: "An unexpected server error occurred.",
    }, 500);
  }
});
