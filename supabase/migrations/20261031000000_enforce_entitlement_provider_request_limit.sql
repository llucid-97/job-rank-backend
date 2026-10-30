begin;

-- Count one admitted paid-provider operation against the account entitlement,
-- while preserving per-provider units as independent hard ceilings.
create table public.provider_request_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  month_utc date not null,
  requests integer not null check (requests > 0),
  primary key (user_id, month_utc)
);

alter table public.provider_request_usage enable row level security;
revoke all on public.provider_request_usage from public, anon, authenticated;
grant select, insert, update on public.provider_request_usage to service_role;

create or replace function public.consume_provider_quota(
  p_user_id uuid, p_kind text, p_units integer, p_limit integer
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz;
  v_month_utc date;
  entitlement_limit integer;
  entitlement_status text;
  monthly_requests integer;
  kind_units integer;
begin
  if p_user_id is null or p_kind is null or p_kind not in ('jev', 'llm', 'jobsdb')
     or p_units is null or p_units <= 0 or p_limit is null or p_limit < 0 then
    raise exception 'Invalid provider quota arguments';
  end if;

  -- Serialize this user's short quota transaction across provider kinds.
  -- This lets both counters be prechecked and updated atomically.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-quota:' || p_user_id::text, 0)
  );

  -- Sample after acquiring the lock so a waiter crossing month-end is charged
  -- to the current UTC calendar month.
  v_now := pg_catalog.clock_timestamp();
  v_month_utc := pg_catalog.date_trunc('month', v_now at time zone 'UTC')::date;

  select account_status, monthly_request_limit
    into entitlement_status, entitlement_limit
    from public.user_entitlements
    where user_id = p_user_id
    for share;

  if not found or entitlement_status is distinct from 'active'
     or entitlement_limit is null or entitlement_limit < 0 then
    raise exception 'An active monthly request entitlement is required';
  end if;

  if p_units > p_limit then
    return false;
  end if;

  select requests into monthly_requests
    from public.provider_request_usage
    where user_id = p_user_id and month_utc = v_month_utc;
  if coalesce(monthly_requests, 0) >= entitlement_limit then
    return false;
  end if;

  select units into kind_units
    from public.provider_quota_usage
    where user_id = p_user_id and kind = p_kind and month_utc = v_month_utc;
  if coalesce(kind_units, 0) > p_limit - p_units then
    return false;
  end if;

  insert into public.provider_quota_usage as usage (user_id, kind, month_utc, units)
  values (p_user_id, p_kind, v_month_utc, p_units)
  on conflict (user_id, kind, month_utc) do update
    set units = usage.units + excluded.units;

  insert into public.provider_request_usage as usage (user_id, month_utc, requests)
  values (p_user_id, v_month_utc, 1)
  on conflict (user_id, month_utc) do update
    set requests = usage.requests + excluded.requests;

  return true;
end;
$$;

revoke all on function public.consume_provider_quota(uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_provider_quota(uuid, text, integer, integer)
  to service_role;

commit;
