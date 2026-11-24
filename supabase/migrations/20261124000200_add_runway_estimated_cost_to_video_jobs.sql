alter table public.video_generations
 add column if not exists owner_provider_cost_usd numeric(14,6)
 check (owner_provider_cost_usd is null or owner_provider_cost_usd >= 0);
