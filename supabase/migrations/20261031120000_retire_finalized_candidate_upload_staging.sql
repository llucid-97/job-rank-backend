begin;

-- Successful conversions no longer occupy a pending-upload slot. Keep their
-- intent rows through the existing three-hour expiry as tombstones for signed
-- upload tokens that might recreate a source object after immediate removal.
create or replace function public.create_candidate_document_upload_intent(
  p_id uuid,
  p_user_id uuid,
  p_purge_after timestamptz
) returns boolean
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  pending_uploads integer;
  recent_starts integer;
begin
  if p_id is null or p_user_id is null or p_purge_after is null then
    raise exception 'Invalid candidate document upload intent';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':candidate-document-uploads', 0)
  );

  select
    count(*) filter (where finalized_at is null)::integer,
    count(*) filter (where created_at > pg_catalog.clock_timestamp() - interval '1 hour')::integer
  into pending_uploads, recent_starts
  from public.candidate_document_upload_intents
  where user_id = p_user_id;

  -- Completed rows remain as signed-token tombstones but no longer occupy a pending slot.
  -- The rolling start cap also bounds repeated successful extraction costs.
  if pending_uploads >= 5 or recent_starts >= 30 then
    return false;
  end if;

  insert into public.candidate_document_upload_intents (id, user_id, purge_after)
  values (p_id, p_user_id, p_purge_after);
  return true;
end;
$function$;

revoke all on function public.create_candidate_document_upload_intent(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_candidate_document_upload_intent(uuid, uuid, timestamptz)
  to service_role;

-- Claim source removal without deleting the row or shortening its signed-token
-- safety window. This shares the cleanup lease with the scheduled worker.
create function public.claim_finalized_candidate_document_upload_retirement(
  p_id uuid,
  p_user_id uuid,
  p_claim_token uuid
) returns text
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  upload_intent public.candidate_document_upload_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_id is null or p_user_id is null or p_claim_token is null then
    raise exception using errcode = '22023', message = 'Invalid candidate document retirement claim.';
  end if;

  select * into upload_intent
  from public.candidate_document_upload_intents
  where id = p_id and user_id = p_user_id
  for update;

  if not found then return 'not_found'; end if;
  if upload_intent.finalized_at is null then return 'not_finalized'; end if;
  if upload_intent.cleanup_claim_until > v_now
     or upload_intent.finalize_claim_until > v_now then
    return 'busy';
  end if;

  update public.candidate_document_upload_intents
  set cleanup_claim_token = p_claim_token,
      cleanup_claim_until = v_now + interval '5 minutes'
  where id = p_id and user_id = p_user_id;

  return 'claimed';
end;
$function$;

revoke all on function public.claim_finalized_candidate_document_upload_retirement(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_finalized_candidate_document_upload_retirement(uuid, uuid, uuid)
  to service_role;

commit;
