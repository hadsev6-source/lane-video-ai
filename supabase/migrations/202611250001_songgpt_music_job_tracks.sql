create table if not exists public.songgpt_music_job_tracks (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.music_generation_jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  track_index integer not null check (track_index between 1 and 3),
  provider_song_id bigint,
  title text,
  duration_seconds numeric,
  lyrics text,
  style text,
  storage_path text not null,
  created_at timestamptz not null default now(),
  unique (job_id, track_index)
);
create index if not exists songgpt_music_job_tracks_user_job_idx
  on public.songgpt_music_job_tracks(user_id, job_id);
alter table public.songgpt_music_job_tracks enable row level security;
