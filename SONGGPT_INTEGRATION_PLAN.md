# SongGPT API integration plan for LANE AI STUDIO

Status: isolated integration branch created (`songgpt-integration-test`). No production code or deployed function has been changed. Provider adapter implementation is intentionally blocked until the authenticated SongGPT API reference confirms request, polling, and audio-output schemas.

## Provider facts verified from SongGPT's public API page (checked 2026-11-25)

- API generation endpoint: `POST /v1/music/generate`.
- One generation call returns two song versions.
- Published generation price: USD 0.10 per call (USD 0.05 per returned version).
- API wallet is prepaid; no subscription or monthly minimum is required.
- Published top-ups include USD 5, 10, 25, 50, 100 and 500 (or whole amounts from USD 5 to 2,000); balance does not expire.
- Failed, timed-out or moderation-blocked tasks are described as automatically refunded.
- Task submission is asynchronous; typical completion is stated as 1–2 minutes; up to five tasks may run concurrently.
- SongGPT states that API outputs include a commercial license for use in products, videos, games and client work.
- Balance checks, status checks and uploads are described as free.

Official source: https://www.songgpt.ai/open-api

## Current LANE compatibility requirements

Keep the existing UI contract and these modes:
- AI Write Lyrics
- My Own Lyrics
- No Lyrics / instrumental
- Existing style, mood, language, BPM, voice-character and custom-style inputs
- Existing account authentication, job ownership, credit debit/refund flow
- Save finished audio into the existing `user-songs` Storage bucket and user folder
- Keep the output usable by the existing music-video workflow

The current generator uses the `music_generation_jobs` table, `debit_music_credits` and `refund_music_credits` RPCs, and signed playback/download URLs. Preserve these behaviors.

## Proposed product behavior

- Keep the current consumer price at 25 LANE credits per generation initially.
- **One LANE generation action = one 25-credit debit = both SongGPT versions delivered to the customer.** Both versions come from the same API call; never make a second generate call for the alternate.
- The official public API page says every generate call returns two full song versions for USD 0.10. Store both outputs from that single call in the user's `user-songs` folder, provide signed playback/download URLs for both, and display them as Version 1 and Version 2 in the same generation result. Do not make a second API call and do not charge additional LANE credits for the second version.
- Debit credits once per provider generation job, not once per returned take.
- If the provider rejects the request before accepting it, refund LANE credits.
- If the provider reports a terminal failed task, refund LANE credits exactly once.
- Record the provider job ID and provider/model metadata for support and owner cost reporting.
- Never expose the SongGPT API key in browser code or logs.

## Cost model to validate before enabling paid production traffic

At the published USD 0.10 per call, two returned versions cost USD 0.05 each. The 25 LANE credits are charged once for the pair. At the existing EUR 5 package (550 credits), 25 credits represent approximately EUR 0.227 in gross customer revenue before taxes/fees; using the planning FX rate 0.9168 EUR/USD, the SongGPT call costs approximately EUR 0.092, leaving approximately EUR 0.135 gross contribution per generation pair before VAT, Stripe, FX spread, storage, hosting, retries and support. This is a planning estimate, not a final margin guarantee.

## Current implementation status (2026-11-25)\n\n- Created branch `songgpt-integration-test` from the existing isolated test branch.\n- Confirmed the LANE frontend invokes `generate-music` with `start` and `status` actions and expects one `audioUrl`; the current Edge Function is WaveSpeed-specific.\n- Confirmed the current job pipeline debits credits through `debit_music_credits`, refunds through `refund_music_credits`, stores one output in `user-songs`, and returns signed playback/download URLs.\n- A direct provider swap is not safe yet: SongGPT publicly confirms `POST /v1/music/generate`, two tracks per call, and asynchronous processing, but its public page snapshot does not specify the JSON request, task ID field, status route/shape, or audio URLs. The current LANE UI also needs a deliberate two-track result display rather than silently dropping one result.\n- No SongGPT API request has been sent and no provider credits have been spent.
- Product decision recorded and confirmed by owner: one LANE generation consumes 25 credits once and delivers both SongGPT versions from the same $0.10 API call. Each version is not separately charged. Both versions are required, not an optional alternate.\n\n## Required technical checks before implementation is enabled

The public API landing page confirms the submission route but does not expose enough machine-readable detail in the page snapshot for us to safely guess:
- exact request JSON fields and enum values for lyrics/instrumental/model options;
- exact response schema and task identifier field;
- exact status/polling endpoint and terminal status values;
- exact audio download URL behavior, content type and expiry;
- whether outputs are MP3, WAV, or both, and whether WAV can be requested;
- maximum prompt/lyrics sizes, duration constraints and language handling;
- idempotency support and provider-side concurrency/error semantics.

Obtain the official API reference/OpenAPI document or confirm these details from the authenticated API dashboard before coding the provider adapter. Do not infer undocumented routes.

## Test matrix

1. API-key validation and balance check from a server-side Edge Function.
2. AI-written lyrics generation.
3. User-supplied lyrics generation.
4. Instrumental generation.
5. Both returned tracks are downloaded, stored in the user's folder, signed and playable as two alternatives; one 25-credit debit total and one provider call.
6. WAV/MP3 compatibility with `generate-music-video`.
7. Provider timeout, rejection, moderation failure and terminal task failure.
8. Exactly-once LANE credit refund on failure; no duplicate debit/refund under repeated status polling.
9. User A cannot read or download User B's job or files.
10. Existing WaveSpeed path and production UI remain unchanged during the test phase.

## Rollout guardrails

- Work only on `soundverse-integration-test` or a dedicated SongGPT test branch.
- Do not modify or deploy production `generate-music` until the test matrix passes and the owner explicitly approves the cutover.
- Keep `WAVESPEED_API_KEY` and the existing WaveSpeed production function untouched as rollback.
- Store the provider secret only as Supabase Edge Function secret `SONGGPT_API_KEY`.


## Implementation added to the isolated test branch (2026-11-25)

The supplied official OpenAPI 3.1.0 JSON/YAML documents were inspected. Confirmed API details:
- Server base: `https://www.songgpt.ai/openapi/v1`
- Generate: `POST /music/generate`; bearer key; success requires HTTP success and `code === 0`; save `data.unique_id` (and task_id for diagnostics).
- Status: `POST /music/tasks/status` with `{ "unique_ids": ["..."] }`; poll every few seconds until `is_complete === true`.
- Task states documented: pending, running, partial, succeeded, failed.
- Audio URLs are `songs[].audio_url` and may remain null until the audio has been transferred to SongGPT storage. A succeeded task with unavailable track audio is not a reason to resubmit.
- Simple mode accepts a prompt up to 3,000 characters; non-instrumental simple mode supports `n` from 1 to 3. Custom mode requires style and title; non-instrumental custom mode also requires lyrics/prompt. Custom duration is 10–360 seconds. Status queries are free.
- SongGPT explicitly warns that this API release has no client idempotency-key protocol: after a timeout, query the existing task and do not automatically submit again.

Files added/updated in this branch:
- `supabase/migrations/202611250001_songgpt_music_job_tracks.sql`: isolated table for per-version metadata and storage paths.
- `supabase/functions/generate-music-songgpt-test/index.ts`: separate test Edge Function; does not replace the existing WaveSpeed `generate-music` function. It charges once, submits one SongGPT task, polls by unique_id, downloads available song audio into the user's `user-songs` folder and signs the track URLs.
- `index.html`: test branch UI points the music form at the separate test function and renders a second audio player when a second track is returned.
- Existing production function remains untouched.

Important remaining gates:
- The new migration and Edge Function have NOT been applied/deployed to Supabase. The test branch is code-only at this point.
- No SongGPT API request has been sent; no SongGPT balance has been spent.
- The table migration must be applied to the test database before the test Edge Function can store track rows.
- Need run static checks and test cases for simple, custom lyrics, instrumental, two returned tracks, partial/missing audio, provider failure, timeouts and refund idempotency.
- The OpenAPI schema says `n` is only forwarded for non-instrumental simple generation; custom/instrumental branches do not use it. Verify the provider returns two versions in those modes during a controlled test before production.
- Do not deploy to production or switch production traffic until tests pass and the owner explicitly approves.
