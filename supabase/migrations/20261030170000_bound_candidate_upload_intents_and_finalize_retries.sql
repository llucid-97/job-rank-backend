begin;

alter table public.candidate_document_upload_intents
  add column if not exists final_storage_path text;

-- Serialize intent creation per user so concurrent requests cannot exceed the
-- outstanding-upload limit. Expired intents count until the cleanup worker
-- removes them, naturally applying backpressure if cleanup falls behind.
create or replace function public.create_candidate_document_upload_intent(
  p_id uuid,
  p_user_id uuid,
  p_purge_after timestamptz
) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  outstanding integer;
begin
  if p_id is null or p_user_id is null or p_purge_after is null then
    raise exception 'Invalid candidate document upload intent';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':candidate-document-uploads', 0)
  );

  select count(*)::integer into outstanding
  from public.candidate_document_upload_intents
  where user_id = p_user_id;

  if outstanding >= 5 then
    return false;
  end if;

  insert into public.candidate_document_upload_intents (id, user_id, purge_after)
  values (p_id, p_user_id, p_purge_after);
  return true;
end;
$$;
revoke all on function public.create_candidate_document_upload_intent(uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.create_candidate_document_upload_intent(uuid, uuid, timestamptz)
  to service_role;

-- A stable upload UUID is the idempotency key. Lock it before checking for an
-- existing row so concurrent retries return the committed row instead of
-- attempting a second insert/revision.
create or replace function public.replace_candidate_document(
  p_id uuid,
  p_user_id uuid,
  p_document_type text,
  p_filename text,
  p_storage_path text,
  p_extracted_text text,
  p_content_hash text
)
returns public.candidate_documents
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  document_kind public.candidate_documents.document_type%type;
  next_revision integer;
  existing_document public.candidate_documents%rowtype;
  new_document public.candidate_documents%rowtype;
begin
  document_kind := p_document_type;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('candidate-document-upload:' || p_id::text, 0)
  );

  select * into existing_document
  from public.candidate_documents
  where id = p_id
  for update;
  if found then
    if existing_document.user_id = p_user_id
       and existing_document.document_type = document_kind
       and existing_document.filename = p_filename
       and existing_document.storage_path = p_storage_path
       and existing_document.extracted_text = p_extracted_text
       and existing_document.content_hash = p_content_hash then
      return existing_document;
    end if;
    raise exception using errcode = 'P0001', message = 'Upload ID was already finalized with different content.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || p_document_type, 0)
  );

  select coalesce(max(revision), 0) + 1 into next_revision
  from public.candidate_documents
  where user_id = p_user_id and document_type = document_kind;

  update public.candidate_documents
  set is_active = false
  where user_id = p_user_id and document_type = document_kind and is_active;

  insert into public.candidate_documents (
    id, user_id, document_type, filename, storage_path,
    extracted_text, content_hash, revision, is_active
  ) values (
    p_id, p_user_id, document_kind, p_filename, p_storage_path,
    p_extracted_text, p_content_hash, next_revision, true
  )
  returning * into new_document;

  return new_document;
end;
$function$;

revoke all on function public.replace_candidate_document(uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.replace_candidate_document(uuid, uuid, text, text, text, text, text)
  to service_role;

commit;
