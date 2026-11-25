# SongGPT API integration plan for LANE AI STUDIO

Status: preparation only. This document does not change the production music generator.

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
- A SongGPT generation call returns two alternatives. Save both outputs and show both to the user; do not silently discard the second take.
- Debit credits once per provider generation job, not once per returned take, unless product economics are deliberately changed later.
- If the provider rejects the request before accepting it, refund LANE credits.
- If the provider reports a terminal failed task, refund LANE credits exactly once.
- Record the provider job ID and provider/model metadata for support and owner cost reporting.
- Never expose the SongGPT API key in browser code or logs.

## Cost model to validate before enabling paid production traffic

At the published USD 0.10 per call, two returned versions cost USD 0.05 each if both are retained and delivered. If only one take is delivered, the effective cost of the delivered take is the full USD 0.10 call cost. Compare this against the existing LANE package revenue per 25 credits and include FX, VAT, Stripe, storage, retries and support costs before finalizing margin.

## Required technical checks before implementation is enabled

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
5. Two returned tracks: both downloaded, stored, signed and playable.
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
