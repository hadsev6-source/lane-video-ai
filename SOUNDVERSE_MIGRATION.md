# Soundverse migration (staging branch)

This branch isolates the Soundverse v5 migration from production.

## Current production behavior
- `generate-music` continues to use WaveSpeed.
- Existing credit debit/refund RPCs and storage workflow remain unchanged.
- The frontend continues to call `generate-music`.

## Provider API findings
- Song generation: `POST https://apiv2.soundverse.ai/v5/generate/song`.
- Instrumental generation: `POST https://apiv2.soundverse.ai/v5/generate/music`.
- Polling: `GET /v5/status?job_id=...`.
- The v5 docs list prompt, lyrics and gender/version options, but do not document a duration parameter. Do not silently drop the current duration selector until product behavior is agreed.
- Standard license is license tier 2; it is $0.11 per song in the current published v5 price table. Distribution is tier 3 at $0.14. Confirm business rights for the actual resale/service model before production use.

## Safe rollout
1. Validate `SOUNDVERSE_API_KEY` with the owner-only `soundverse-connection-check` function.
2. Implement and test the provider adapter without changing the active production route.
3. Test both vocal songs and instrumentals, signed download URL retrieval, Supabase Storage upload, job status transitions, and credit refunds.
4. Switch the frontend only after successful end-to-end tests and explicit owner approval.
5. Keep WaveSpeed rollback available until the new route is proven stable.
