-- LANE AI STUDIO automatic owner push notifications.
-- Configure Edge Function secret PUSH_EVENT_SECRET and store the SAME value
-- in Supabase Vault under the name lane_push_event_secret.
-- Set app.settings.supabase_url in the database (project URL), then run this SQL.

create extension if not exists pg_net with schema extensions;

create or replace function public.lane_dispatch_owner_push()
returns trigger language plpgsql security definer
set search_path = public, extensions, vault
as $$
declare
 d jsonb := to_jsonb(new); ev text; detail text; secret_value text;
begin
 if tg_table_name='analytics_events' then
  ev:=d->>'event_name';
  if ev not in ('page_view','registration','login','generation_started','generation_completed','generation_failed') then return new; end if;
  detail:=coalesce(nullif(d#>>'{metadata,service}',''),nullif(d->>'page_path',''),nullif(d->>'country_name',''));
 elsif tg_table_name='owner_financial_ledger' then
  if lower(coalesce(d->>'entry_type','')) not like '%payment%' and lower(coalesce(d->>'entry_type','')) not like '%revenue%' then return new; end if;
  ev:='payment_received'; detail:=coalesce(nullif(d->>'reference_id',''),'Stripe');
 else return new;
 end if;
 select decrypted_secret into secret_value from vault.decrypted_secrets where name='lane_push_event_secret' limit 1;
 if secret_value is null or secret_value='' then raise warning 'LANE push secret missing from Vault'; return new; end if;
 perform net.http_post(
  url:=current_setting('app.settings.supabase_url',true)||'/functions/v1/analytics-push',
  headers:=jsonb_build_object('Content-Type','application/json','x-push-event-secret',secret_value),
  body:=jsonb_build_object('event_name',ev,'detail',detail,'event_id',coalesce(d->>'id',d->>'reference_id',txid_current()::text))
 );
 return new;
end; $$;

drop trigger if exists lane_push_analytics_event on public.analytics_events;
create trigger lane_push_analytics_event after insert on public.analytics_events
for each row execute function public.lane_dispatch_owner_push();

drop trigger if exists lane_push_financial_ledger on public.owner_financial_ledger;
create trigger lane_push_financial_ledger after insert on public.owner_financial_ledger
for each row execute function public.lane_dispatch_owner_push();
