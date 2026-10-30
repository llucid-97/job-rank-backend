-- Bound each paid search using the same atomic per-user monthly accounting as AI calls.
begin;
alter table public.provider_quota_usage drop constraint provider_quota_usage_kind_check;
alter table public.provider_quota_usage add constraint provider_quota_usage_kind_check check (kind in ('jev', 'llm', 'jobsdb'));

create or replace function public.consume_provider_quota(
  p_user_id uuid, p_kind text, p_units integer, p_limit integer
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  consumed integer;
begin
  if p_user_id is null or p_kind is null or p_kind not in ('jev', 'llm', 'jobsdb')
     or p_units is null or p_units <= 0 or p_limit is null or p_limit < 0 then
    raise exception 'Invalid provider quota arguments';
  end if;
  if p_units > p_limit then
    return false;
  end if;

  insert into public.provider_quota_usage as usage (user_id, kind, month_utc, units)
  values (p_user_id, p_kind, pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'UTC')::date, p_units)
  on conflict (user_id, kind, month_utc) do update
    set units = usage.units + excluded.units
    where usage.units <= p_limit - excluded.units
  returning units into consumed;
  return found;
end;
$$;
commit;
