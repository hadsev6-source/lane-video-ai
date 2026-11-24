
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "black-forest-labs/FLUX-2-klein-4b";
const CREDITS_PER_IMAGE = 15;
const MAX_IMAGES = 8;
const MAX_PROMPT_LENGTH = 5000;

const OWNER_USER_ID = "dce2d514-964d-49be-b83d-45e6721b49a7";
const OWNER_CREDITS_PER_EUR = 140;
const OWNER_DEFAULT_USD_TO_EUR = 0.9168;

function isOwnerUser(userId: string): boolean {
  return userId === OWNER_USER_ID;
}

function ownerCreditsForUsd(usd: number): number {
  const rate = Number(Deno.env.get("OWNER_USD_TO_EUR") || OWNER_DEFAULT_USD_TO_EUR);
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(usd) || usd < 0) {
    throw new Error("Invalid owner API cost conversion configuration.");
  }
  return Math.max(1, Math.ceil(usd * rate * OWNER_CREDITS_PER_EUR));
}

async function recordOwnerApiCost(admin: any, entry: {
  userId: string; service: string; provider: string; model: string;
  usd: number; credits: number; generationId?: string; durationSeconds?: number;
  metadata?: Record<string, unknown>;
}) {
  const rate = Number(Deno.env.get("OWNER_USD_TO_EUR") || OWNER_DEFAULT_USD_TO_EUR);
  const { error } = await admin.from("owner_api_costs").insert({
    user_id: entry.userId, service: entry.service, provider: entry.provider,
    model: entry.model, amount_usd: entry.usd, usd_to_eur: rate,
    amount_eur: entry.usd * rate, credits_charged: entry.credits,
    generation_id: entry.generationId || null,
    duration_seconds: entry.durationSeconds ?? null, metadata: entry.metadata || {},
  });
  if (error) console.error("Could not record owner API cost:", error);
}


function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function errorText(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("MY_SERVICE_ROLE_KEY");

  const deepinfraKey = Deno.env.get("DEEPINFRA_API_KEY");

  if (!supabaseUrl || !serviceRoleKey || !deepinfraKey) {
    console.error("Missing server configuration.", {
      supabaseUrl: !!supabaseUrl,
      serviceRoleKey: !!serviceRoleKey,
      deepinfraKey: !!deepinfraKey,
    });

    return json({
      error: "Server configuration is incomplete. Check Supabase Secrets.",
    }, 500);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");

  if (!jwt) {
    return json({ error: "Please sign in first." }, 401);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const { data: userData, error: userError } =
    await admin.auth.getUser(jwt);

  const user = userData?.user;

  if (userError || !user) {
    console.error("Authentication error:", errorText(userError));

    return json({
      error: "Your session is invalid. Please sign in again.",
    }, 401);
  }

  let reservedCredits = 0;
  let generatedCount = 0;
  let creditsReserved = false;
  let owner = false;
  let creditsPerImage = CREDITS_PER_IMAGE;

  const generated: Array<{
    path: string;
    url: string;
  }> = [];

  try {
    const form = await req.formData();

    const prompt = String(form.get("prompt") || "").trim();

    const style = String(
      form.get("style") || "Photorealistic",
    ).trim();

    const quantity = Number(form.get("quantity") || 1);
    const reference = form.get("reference");

    if (!prompt) {
      return json({
        error: "Please describe your image first.",
      }, 400);
    }

    if (prompt.length > MAX_PROMPT_LENGTH) {
      return json({
        error: "The prompt is too long.",
      }, 400);
    }

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > MAX_IMAGES
    ) {
      return json({
        error: `Choose between 1 and ${MAX_IMAGES} images.`,
      }, 400);
    }

    if (reference && !(reference instanceof File)) {
      return json({
        error: "Invalid reference image.",
      }, 400);
    }

    if (reference instanceof File) {
      if (reference.size <= 0) {
        return json({
          error: "Reference image is empty.",
        }, 400);
      }

      if (
        !["image/jpeg", "image/png", "image/webp"].includes(
          reference.type.toLowerCase(),
        )
      ) {
        return json({
          error: "Reference image must be JPG, PNG or WEBP.",
        }, 400);
      }

      if (reference.size > 10 * 1024 * 1024) {
        return json({
          error: "Reference image must be 10 MB or smaller.",
        }, 400);
      }
    }

    owner = isOwnerUser(user.id);
    creditsPerImage = owner ? ownerCreditsForUsd(0.014) : CREDITS_PER_IMAGE;
    reservedCredits = quantity * creditsPerImage;

    const { data: debitData, error: debitError } =
      await admin.rpc("debit_image_credits", {
        p_user_id: user.id,
        p_credits: reservedCredits,
      });

    if (debitError) {
      throw new Error(
        `Credit check failed: ${errorText(debitError)}`,
      );
    }

    if (!debitData?.success) {
      return json({
        error:
          "You do not have enough credits. Please buy a credit package.",
      }, 402);
    }

    creditsReserved = true;

    for (let i = 0; i < quantity; i++) {
      const finalPrompt =
        `${prompt}\nVisual style: ${style}. Create a polished, high-quality image.`;

      let response: Response;

      if (reference instanceof File) {
        const apiForm = new FormData();

        apiForm.append("model", MODEL);
        apiForm.append("prompt", finalPrompt);
        apiForm.append("image", reference, reference.name);
        apiForm.append("n", "1");
        apiForm.append("response_format", "b64_json");

        response = await fetch(
          "https://api.deepinfra.com/v1/openai/images/edits",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${deepinfraKey}`,
            },
            body: apiForm,
          },
        );
      } else {
        response = await fetch(
          "https://api.deepinfra.com/v1/openai/images/generations",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${deepinfraKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: MODEL,
              prompt: finalPrompt,
              size: "1024x1024",
              n: 1,
              response_format: "b64_json",
            }),
          },
        );
      }

      const responseText = await response.text();

      let result: any;

      try {
        result = JSON.parse(responseText);
      } catch {
        result = { raw_response: responseText };
      }

      if (!response.ok) {
        console.error("DeepInfra API error:", {
          status: response.status,
          response: result,
        });

        throw new Error(
          `DeepInfra error ${response.status}: ${errorText(
            result?.error?.message ||
            result?.detail ||
            result?.raw_response ||
            result,
          )}`,
        );
      }

      const base64 = result?.data?.[0]?.b64_json;

      if (!base64 || typeof base64 !== "string") {
        console.error("Unexpected DeepInfra response:", result);

        throw new Error(
          "DeepInfra returned no image data: " +
          errorText(result),
        );
      }

      let binary: Uint8Array;

      try {
        binary = Uint8Array.from(
          atob(base64),
          (character) => character.charCodeAt(0),
        );
      } catch {
        throw new Error("DeepInfra returned invalid image data.");
      }

      const path =
        `${user.id}/${crypto.randomUUID()}.jpg`;

      const { error: uploadError } = await admin.storage
        .from("user-generated-images")
        .upload(path, binary, {
          contentType: "image/jpeg",
          upsert: false,
        });

      if (uploadError) {
        throw new Error(
          `Image storage failed: ${errorText(uploadError)}`,
        );
      }

      const { data: signed, error: signedError } =
        await admin.storage
          .from("user-generated-images")
          .createSignedUrl(path, 60 * 60 * 24 * 7);

      if (signedError || !signed?.signedUrl) {
        console.error("Image signed URL creation failed:", signedError);

        const { error: removeError } = await admin.storage
          .from("user-generated-images")
          .remove([path]);

        if (removeError) {
          console.error(
            "Could not remove image after signed URL failure:",
            removeError,
          );

          // The image remains saved, so its credits must not be refunded.
          generated.push({
            path,
            url: "",
          });

          generatedCount++;
        }

        throw new Error(
          "Could not create image preview link: " +
          errorText(signedError),
        );
      }

      generated.push({
        path,
        url: signed.signedUrl,
      });

      generatedCount++;
      if (owner) await recordOwnerApiCost(admin, {
        userId: user.id, service: "image_generation", provider: "DeepInfra",
        model: MODEL, usd: 0.014, credits: creditsPerImage,
        generationId: path, metadata: { size: "1024x1024", referenceImage: reference instanceof File },
      });
    }

    return json({
      success: true,
      images: generated,
      creditsUsed: generatedCount * creditsPerImage,
      creditsPerImage,
      requestedQuantity: quantity,
      generatedQuantity: generatedCount,
    });
  } catch (error) {
    const message = errorText(error);

    const details = {
      name: error instanceof Error ? error.name : "UnknownError",
      message,
      stack: error instanceof Error ? error.stack : undefined,
    };

    console.error(
      "GENERATE IMAGE FULL ERROR:",
      JSON.stringify(details, null, 2),
    );

    const unusedCredits = creditsReserved
      ? reservedCredits - generatedCount * creditsPerImage
      : 0;

    let refundPending = false;

    if (unusedCredits > 0) {
      const { error: refundError } = await admin.rpc(
        "refund_image_credits",
        {
          p_user_id: user.id,
          p_credits: unusedCredits,
        },
      );

      if (refundError) {
        refundPending = true;

        console.error(
          "CREDIT REFUND ERROR:",
          errorText(refundError),
        );
      }
    }

    // If some images were generated successfully, return them
    // instead of hiding them behind a total failure response.
    if (generatedCount > 0) {
      return json({
        success: true,
        partial: true,
        images: generated,
        creditsUsed: generatedCount * creditsPerImage,
        creditsPerImage,
        requestedQuantity: Number(
          generatedCount + Math.max(
            0,
            (reservedCredits / creditsPerImage) - generatedCount,
          ),
        ),
        generatedQuantity: generatedCount,
        warning: message,
        refundPending,
      });
    }

    return json({
      success: false,
      error: message,
      creditsUsed: 0,
      refundPending,
    }, 500);
  }
});