begin;

alter table public.user_preferences
  drop constraint user_preferences_fetch_limit;

alter table public.user_preferences
  add constraint user_preferences_fetch_limit
  check (jobs_fetch_limit = any (array[1, 3, 5, 10, 25, 50, 100]));

-- Keep the existing quota lock and counters, but let the server-controlled
-- alpha path record active-account usage without either monthly quota ceiling.
create function public.record_alpha_provider_usage(
  p_user_id uuid,
  p_kind text,
  p_units integer
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month_utc date;
  entitlement_status text;
  max_request_units integer;
begin
  if p_user_id is null or p_kind is null
     or p_kind not in ('jev', 'llm', 'jobsdb')
     or p_units is null or p_units <= 0 then
    raise exception 'Invalid alpha provider usage arguments';
  end if;

  -- Preserve the normal path's per-operation unit bound while removing only
  -- the account-month and per-kind-month ceilings in alpha mode.
  max_request_units := case p_kind when 'jev' then 2000 else 1 end;
  if p_units > max_request_units then
    raise exception 'Invalid alpha provider usage arguments';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('provider-quota:' || p_user_id::text, 0)
  );

  v_month_utc := pg_catalog.date_trunc(
    'month', pg_catalog.clock_timestamp() at time zone 'UTC'
  )::date;

  select account_status into entitlement_status
    from public.user_entitlements
    where user_id = p_user_id
    for share;

  if not found or entitlement_status is distinct from 'active' then
    raise exception 'An active account entitlement is required';
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

revoke all on function public.record_alpha_provider_usage(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.record_alpha_provider_usage(uuid, text, integer)
  to service_role;

commit;
