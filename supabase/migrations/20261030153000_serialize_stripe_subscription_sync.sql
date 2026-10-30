begin;

-- Serialize current-state reads and their subscription/entitlement writes across
-- serverless instances. Expired leases recover work from crashed handlers.
create table if not exists public.stripe_subscription_sync_locks (
  stripe_subscription_id text primary key,
  processing_started_at timestamptz not null,
  processing_claim_token uuid not null
);

alter table public.stripe_subscription_sync_locks enable row level security;
revoke all on table public.stripe_subscription_sync_locks from public, anon, authenticated;
grant select, insert, update, delete on table public.stripe_subscription_sync_locks to service_role;

create or replace function public.claim_stripe_subscription_sync(
  p_subscription_id text,
  p_claim_token uuid
) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  outcome text;
begin
  if p_subscription_id is null or p_claim_token is null then
    raise exception 'Invalid Stripe subscription sync claim arguments';
  end if;

  insert into public.stripe_subscription_sync_locks as existing (
    stripe_subscription_id,
    processing_started_at,
    processing_claim_token
  ) values (
    p_subscription_id,
    pg_catalog.clock_timestamp(),
    p_claim_token
  )
  on conflict (stripe_subscription_id) do update set
    processing_started_at = pg_catalog.clock_timestamp(),
    processing_claim_token = excluded.processing_claim_token
  where existing.processing_started_at <=
    pg_catalog.clock_timestamp() - interval '10 minutes'
  returning 'claimed' into outcome;

  if found then return outcome; end if;
  return 'busy';
end;
$$;

create or replace function public.release_stripe_subscription_sync(
  p_subscription_id text,
  p_claim_token uuid
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  released boolean;
begin
  delete from public.stripe_subscription_sync_locks
  where stripe_subscription_id = p_subscription_id
    and processing_claim_token = p_claim_token
  returning true into released;
  return coalesce(released, false);
end;
$$;

revoke all on function public.claim_stripe_subscription_sync(text, uuid)
  from public, anon, authenticated;
revoke all on function public.release_stripe_subscription_sync(text, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_stripe_subscription_sync(text, uuid)
  to service_role;
grant execute on function public.release_stripe_subscription_sync(text, uuid)
  to service_role;

commit;
