begin;

-- Storage operations happen outside Postgres transactions. These leases make
-- finalization and expiration cleanup mutually exclusive while either is
-- working, and recover automatically if a function is terminated. The five
-- minute leases exceed the API's 120 second function ceiling.
alter table public.candidate_document_upload_intents
  add column if not exists finalize_claim_token uuid,
  add column if not exists finalize_claim_until timestamptz,
  add column if not exists cleanup_claim_token uuid,
  add column if not exists cleanup_claim_until timestamptz,
  add column if not exists finalized_at timestamptz;

create or replace function public.claim_candidate_document_upload_finalization(
  p_id uuid,
  p_user_id uuid,
  p_claim_token uuid,
  p_final_storage_path text
) returns text
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  upload_intent public.candidate_document_upload_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_id is null or p_user_id is null or p_claim_token is null
     or p_final_storage_path is null or p_final_storage_path = '' then
    raise exception using errcode = '22023', message = 'Invalid candidate document finalization claim.';
  end if;

  select * into upload_intent
  from public.candidate_document_upload_intents
  where id = p_id and user_id = p_user_id
  for update;

  if not found then return 'not_found'; end if;
  if upload_intent.finalized_at is not null then return 'completed'; end if;
  if upload_intent.finalize_claim_until > v_now
     and upload_intent.finalize_claim_token is distinct from p_claim_token then
    return 'busy';
  end if;
  if upload_intent.purge_after <= v_now then return 'expired'; end if;
  if upload_intent.cleanup_claim_until > v_now then return 'cleanup_in_progress'; end if;
  if upload_intent.final_storage_path is not null
     and upload_intent.final_storage_path <> p_final_storage_path then
    return 'conflict';
  end if;

  update public.candidate_document_upload_intents
  set final_storage_path = p_final_storage_path,
      finalize_claim_token = p_claim_token,
      finalize_claim_until = v_now + interval '5 minutes'
  where id = p_id and user_id = p_user_id;

  return 'claimed';
end;
$function$;

create or replace function public.complete_candidate_document_upload_finalization(
  p_id uuid,
  p_user_id uuid,
  p_document_type text,
  p_filename text,
  p_storage_path text,
  p_extracted_text text,
  p_content_hash text,
  p_claim_token uuid
) returns public.candidate_documents
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  upload_intent public.candidate_document_upload_intents%rowtype;
  published_document public.candidate_documents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  -- Bound the atomic publication statement so it cannot outlive the lease by
  -- continuing on the database after the API function's 120-second ceiling.
  perform pg_catalog.set_config('statement_timeout', '110s', true);

  select * into upload_intent
  from public.candidate_document_upload_intents
  where id = p_id and user_id = p_user_id
  for update;

  if not found then
    raise exception using errcode = 'P0001', message = 'Upload intent is no longer available.';
  end if;

  if upload_intent.finalized_at is not null then
    return public.replace_candidate_document(
      p_id, p_user_id, p_document_type, p_filename, p_storage_path, p_extracted_text, p_content_hash
    );
  end if;

  if upload_intent.finalize_claim_token is distinct from p_claim_token
     or upload_intent.finalize_claim_until is null
     or upload_intent.finalize_claim_until <= v_now
     or upload_intent.final_storage_path is distinct from p_storage_path
     or upload_intent.cleanup_claim_until > v_now then
    raise exception using errcode = 'P0001', message = 'Candidate document finalization claim was lost.';
  end if;

  published_document := public.replace_candidate_document(
    p_id, p_user_id, p_document_type, p_filename, p_storage_path, p_extracted_text, p_content_hash
  );

  update public.candidate_document_upload_intents
  set finalized_at = v_now,
      finalize_claim_token = null,
      finalize_claim_until = null
  where id = p_id and user_id = p_user_id;

  return published_document;
end;
$function$;

create or replace function public.release_candidate_document_upload_finalization(
  p_id uuid,
  p_user_id uuid,
  p_claim_token uuid
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  released boolean;
begin
  update public.candidate_document_upload_intents
  set finalize_claim_token = null,
      finalize_claim_until = null
  where id = p_id and user_id = p_user_id
    and finalize_claim_token = p_claim_token
    and finalized_at is null;
  released := found;
  return released;
end;
$function$;

-- UPDATE ... RETURNING with row locks is the cleanup claim. A plain SELECT
-- followed by deletion would allow a finalizer to acquire its claim between
-- those two statements.
create or replace function public.claim_candidate_document_uploads_for_cleanup(
  p_claim_token uuid,
  p_limit integer default 100
) returns table (id uuid, user_id uuid, final_storage_path text)
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_claim_token is null then
    raise exception using errcode = '22023', message = 'Invalid candidate document cleanup claim.';
  end if;

  return query
  with claimable as materialized (
    select intent.id
    from public.candidate_document_upload_intents as intent
    where intent.purge_after <= v_now
      and (intent.finalize_claim_until is null or intent.finalize_claim_until <= v_now)
      and (intent.cleanup_claim_until is null or intent.cleanup_claim_until <= v_now)
    order by intent.purge_after, intent.id
    for update of intent skip locked
    limit greatest(1, least(coalesce(p_limit, 100), 100))
  )
  update public.candidate_document_upload_intents as intent
  set cleanup_claim_token = p_claim_token,
      cleanup_claim_until = v_now + interval '5 minutes'
  from claimable
  where intent.id = claimable.id
  returning intent.id, intent.user_id, intent.final_storage_path;
end;
$function$;

create or replace function public.delete_candidate_document_uploads_after_cleanup(
  p_claim_token uuid,
  p_ids uuid[]
) returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  deleted_count integer;
begin
  delete from public.candidate_document_upload_intents
  where cleanup_claim_token = p_claim_token
    and id = any(coalesce(p_ids, array[]::uuid[]));
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$function$;

create or replace function public.release_candidate_document_upload_cleanup(
  p_claim_token uuid,
  p_ids uuid[]
) returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  released_count integer;
begin
  update public.candidate_document_upload_intents
  set cleanup_claim_token = null,
      cleanup_claim_until = null
  where cleanup_claim_token = p_claim_token
    and id = any(coalesce(p_ids, array[]::uuid[]));
  get diagnostics released_count = row_count;
  return released_count;
end;
$function$;

revoke all on function public.claim_candidate_document_upload_finalization(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.complete_candidate_document_upload_finalization(uuid, uuid, text, text, text, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.release_candidate_document_upload_finalization(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.claim_candidate_document_uploads_for_cleanup(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.delete_candidate_document_uploads_after_cleanup(uuid, uuid[])
  from public, anon, authenticated;
revoke all on function public.release_candidate_document_upload_cleanup(uuid, uuid[])
  from public, anon, authenticated;

grant execute on function public.claim_candidate_document_upload_finalization(uuid, uuid, uuid, text) to service_role;
grant execute on function public.complete_candidate_document_upload_finalization(uuid, uuid, text, text, text, text, text, uuid) to service_role;
grant execute on function public.release_candidate_document_upload_finalization(uuid, uuid, uuid) to service_role;
grant execute on function public.claim_candidate_document_uploads_for_cleanup(uuid, integer) to service_role;
grant execute on function public.delete_candidate_document_uploads_after_cleanup(uuid, uuid[]) to service_role;
grant execute on function public.release_candidate_document_upload_cleanup(uuid, uuid[]) to service_role;

commit;

