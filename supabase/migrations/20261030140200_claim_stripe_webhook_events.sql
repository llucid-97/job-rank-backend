begin;

-- A ten-minute lease exceeds Vercel's five-minute Hobby function ceiling and recovers crashed work.
alter table public.stripe_webhook_events
  add column if not exists processing_started_at timestamptz,
  add column if not exists processing_claim_token uuid;

-- Give pre-lease in-flight rows a fresh window before considering them abandoned.
update public.stripe_webhook_events
set processing_started_at = pg_catalog.clock_timestamp()
where processing_status = 'processing'
  and processing_started_at is null;

create or replace function public.claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_api_version text,
  p_payload jsonb,
  p_claim_token uuid
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  outcome text;
  current_status text;
begin
  if p_event_id is null or p_event_type is null or p_payload is null
     or p_claim_token is null then
    raise exception 'Invalid Stripe webhook claim arguments';
  end if;

  insert into public.stripe_webhook_events as existing (
    stripe_event_id,
    event_type,
    livemode,
    stripe_api_version,
    processing_status,
    processing_attempts,
    payload,
    processing_started_at,
    processing_claim_token
  ) values (
    p_event_id,
    p_event_type,
    p_livemode,
    p_api_version,
    'processing',
    1,
    p_payload,
    pg_catalog.clock_timestamp(),
    p_claim_token
  )
  on conflict (stripe_event_id) do update set
    processing_status = 'processing',
    processing_attempts = existing.processing_attempts + 1,
    last_error = null,
    processing_started_at = pg_catalog.clock_timestamp(),
    processing_claim_token = excluded.processing_claim_token
  where existing.processing_status in ('received', 'failed')
     or (
       existing.processing_status = 'processing'
       and coalesce(
         existing.processing_started_at,
         '-infinity'::pg_catalog.timestamptz
       ) <= pg_catalog.clock_timestamp() - interval '10 minutes'
     )
  returning 'claimed' into outcome;

  if found then return outcome; end if;

  select processing_status into current_status
  from public.stripe_webhook_events
  where stripe_event_id = p_event_id;

  if current_status in ('processed', 'ignored') then return current_status; end if;
  return 'busy';
end;
$$;

revoke all on function public.claim_stripe_webhook_event(text, text, boolean, text, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_stripe_webhook_event(text, text, boolean, text, jsonb, uuid)
  to service_role;

commit;
