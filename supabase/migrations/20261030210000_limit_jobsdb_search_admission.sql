begin;

-- Keep paid JobsDB searches bounded across serverless instances. Expired rows
-- recover capacity if an invocation is terminated before its finally block;
-- 150 seconds exceeds this function's configured 120-second maximum duration.
create table public.jobsdb_search_admission_leases (
  request_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  lease_expires_at timestamptz not null
);

create index jobsdb_search_admission_leases_expiry_idx
  on public.jobsdb_search_admission_leases (lease_expires_at);

alter table public.jobsdb_search_admission_leases enable row level security;
revoke all on public.jobsdb_search_admission_leases from public, anon, authenticated;
grant select, insert, delete on public.jobsdb_search_admission_leases to service_role;

create function public.acquire_jobsdb_search_lease(
  p_user_id uuid,
  p_request_id uuid
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz;
  active_total integer;
  active_for_user integer;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'Invalid JobsDB admission lease arguments';
  end if;

  -- Serialize only admission checks, not the upstream request itself.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('jobsdb-search-admission', 0)
  );
  v_now := pg_catalog.clock_timestamp();
  delete from public.jobsdb_search_admission_leases
    where lease_expires_at <= v_now;

  select count(*)::integer,
         (count(*) filter (where user_id = p_user_id))::integer
    into active_total, active_for_user
    from public.jobsdb_search_admission_leases
    where lease_expires_at > v_now;

  -- Preserve room for normal UI bursts while bounding one account and the app.
  if active_total >= 32 or active_for_user >= 4 then
    return false;
  end if;

  insert into public.jobsdb_search_admission_leases (
    request_id, user_id, lease_expires_at
  ) values (
    p_request_id, p_user_id, v_now + interval '150 seconds'
  );
  return true;
end;
$$;

create function public.release_jobsdb_search_lease(
  p_user_id uuid,
  p_request_id uuid
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  released boolean;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'Invalid JobsDB admission lease arguments';
  end if;

  delete from public.jobsdb_search_admission_leases
    where user_id = p_user_id and request_id = p_request_id
    returning true into released;
  return coalesce(released, false);
end;
$$;

revoke all on function public.acquire_jobsdb_search_lease(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.release_jobsdb_search_lease(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.acquire_jobsdb_search_lease(uuid, uuid)
  to service_role;
grant execute on function public.release_jobsdb_search_lease(uuid, uuid)
  to service_role;

commit;
