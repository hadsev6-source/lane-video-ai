-- Owner API cost audit trail. Only service-role Edge Functions may write/read these rows.
create table if not exists public.owner_api_costs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  service text not null,
  provider text not null,
  model text not null,
  amount_usd numeric(14,6) not null check (amount_usd >= 0),
  usd_to_eur numeric(12,8) not null check (usd_to_eur > 0),
  amount_eur numeric(14,6) not null check (amount_eur >= 0),
  credits_charged integer not null check (credits_charged >= 0),
  generation_id text,
  duration_seconds integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists owner_api_costs_user_created_idx
  on public.owner_api_costs (user_id, created_at desc);

alter table public.owner_api_costs enable row level security;
revoke all on public.owner_api_costs from anon, authenticated;
grant all on public.owner_api_costs to service_role;
