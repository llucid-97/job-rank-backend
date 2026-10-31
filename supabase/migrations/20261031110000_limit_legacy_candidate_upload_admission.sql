begin;

-- Bound inline multipart uploads across serverless instances while keeping
-- completed starts in the sliding rate window and crashes in the active cap
-- only until their lease expires.
create table public.candidate_document_direct_upload_leases (
  request_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  lease_expires_at timestamptz not null
);

create index candidate_document_direct_upload_leases_user_started_idx
  on public.candidate_document_direct_upload_leases (user_id, started_at);
create index candidate_document_direct_upload_leases_user_expiry_idx
  on public.candidate_document_direct_upload_leases (user_id, lease_expires_at);

alter table public.candidate_document_direct_upload_leases enable row level security;
revoke all on public.candidate_document_direct_upload_leases from public, anon, authenticated;
grant select, insert, update, delete on public.candidate_document_direct_upload_leases to service_role;

-- Return zero when admitted, otherwise the number of seconds before a retry.
-- The per-user advisory lock makes both the sliding rate and active count
-- atomic across concurrent requests and serverless instances.
create function public.acquire_candidate_document_direct_upload(
  p_user_id uuid,
  p_request_id uuid
) returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  v_now timestamptz;
  recent_starts integer;
  active_uploads integer;
  oldest_recent_start timestamptz;
  earliest_active_expiry timestamptz;
  retry_after integer := 0;
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'Invalid candidate document upload admission arguments';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('candidate-document-direct-upload:' || p_user_id::text, 0)
  );
  v_now := pg_catalog.clock_timestamp();

  -- Keep released/expired rows for the complete rate window, then reclaim
  -- this user's stale rows before counting capacity.
  delete from public.candidate_document_direct_upload_leases
  where user_id = p_user_id
    and started_at <= v_now - interval '1 minute'
    and lease_expires_at <= v_now;

  select
    count(*) filter (where started_at > v_now - interval '1 minute')::integer,
    count(*) filter (where lease_expires_at > v_now)::integer,
    min(started_at) filter (where started_at > v_now - interval '1 minute'),
    min(lease_expires_at) filter (where lease_expires_at > v_now)
  into recent_starts, active_uploads, oldest_recent_start, earliest_active_expiry
  from public.candidate_document_direct_upload_leases
  where user_id = p_user_id;

  if recent_starts >= 12 then
    retry_after := greatest(1, pg_catalog.ceil(extract(epoch from (oldest_recent_start + interval '1 minute' - v_now)))::integer);
  end if;
  if active_uploads >= 3 then
    retry_after := greatest(retry_after,
      greatest(1, pg_catalog.ceil(extract(epoch from (earliest_active_expiry - v_now)))::integer));
  end if;
  if retry_after > 0 then
    return retry_after;
  end if;

  insert into public.candidate_document_direct_upload_leases (
    request_id, user_id, started_at, lease_expires_at
  ) values (
    p_request_id, p_user_id, v_now, v_now + interval '150 seconds'
  );
  return 0;
end;
$$;

create function public.release_candidate_document_direct_upload(
  p_user_id uuid,
  p_request_id uuid
) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  if p_user_id is null or p_request_id is null then
    raise exception 'Invalid candidate document upload release arguments';
  end if;

  update public.candidate_document_direct_upload_leases
  set lease_expires_at = least(lease_expires_at, pg_catalog.clock_timestamp())
  where user_id = p_user_id and request_id = p_request_id;
  return found;
end;
$$;

revoke all on function public.acquire_candidate_document_direct_upload(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.release_candidate_document_direct_upload(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.acquire_candidate_document_direct_upload(uuid, uuid)
  to service_role;
grant execute on function public.release_candidate_document_direct_upload(uuid, uuid)
  to service_role;

commit;
