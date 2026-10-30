begin;

-- Public feeds are free upstream sources, but their proxy still consumes our
-- serverless compute and egress. Keep this budget separate from paid-provider
-- monthly quotas and make the two UTC windows atomic across instances.
create table public.public_feed_request_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  window_kind text not null check (window_kind in ('minute', 'day')),
  window_start timestamptz not null,
  requests integer not null check (requests > 0),
  primary key (user_id, window_kind, window_start)
);

alter table public.public_feed_request_usage enable row level security;
revoke all on public.public_feed_request_usage from public, anon, authenticated;
grant select, insert, update, delete on public.public_feed_request_usage to service_role;

create function public.consume_public_feed_request(p_user_id uuid)
returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz;
  v_minute_start timestamptz;
  v_day_start timestamptz;
  v_minute_requests integer;
  v_day_requests integer;
begin
  if p_user_id is null then
    raise exception 'Invalid public feed quota arguments';
  end if;

  -- Serialize only this user's short quota transaction. Never hold the lock
  -- while the route is waiting on a public feed provider.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('public-feed-quota:' || p_user_id::text, 0)
  );

  -- Sample time after acquiring the account lock, so a waiter that crosses a
  -- UTC boundary is charged to the bucket that is current when it is admitted.
  v_now := pg_catalog.clock_timestamp();
  v_minute_start := pg_catalog.date_trunc('minute', v_now at time zone 'UTC') at time zone 'UTC';
  v_day_start := pg_catalog.date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC';

  -- Retain at most the current minute and day rows for each account.
  delete from public.public_feed_request_usage
    where user_id = p_user_id
      and ((window_kind = 'minute' and window_start < v_minute_start)
        or (window_kind = 'day' and window_start < v_day_start));

  select
    coalesce(max(requests) filter (where window_kind = 'minute'), 0),
    coalesce(max(requests) filter (where window_kind = 'day'), 0)
    into v_minute_requests, v_day_requests
    from public.public_feed_request_usage
    where user_id = p_user_id
      and ((window_kind = 'minute' and window_start = v_minute_start)
        or (window_kind = 'day' and window_start = v_day_start));

  if v_minute_requests >= 240 then
    return greatest(1, pg_catalog.ceil(extract(epoch from (v_minute_start + interval '1 minute' - v_now)))::integer);
  end if;
  if v_day_requests >= 1200 then
    return greatest(1, pg_catalog.ceil(extract(epoch from (v_day_start + interval '1 day' - v_now)))::integer);
  end if;

  insert into public.public_feed_request_usage as usage (user_id, window_kind, window_start, requests)
  values
    (p_user_id, 'minute', v_minute_start, 1),
    (p_user_id, 'day', v_day_start, 1)
  on conflict (user_id, window_kind, window_start) do update
    set requests = usage.requests + excluded.requests;

  -- Zero means admitted. A positive value is the Retry-After delay in seconds.
  return 0;
end;
$$;

revoke all on function public.consume_public_feed_request(uuid)
  from public, anon, authenticated;
grant execute on function public.consume_public_feed_request(uuid)
  to service_role;

commit;
