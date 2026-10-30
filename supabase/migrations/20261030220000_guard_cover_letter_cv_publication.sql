begin;

-- Serialize cover-letter publication with CV replacement/deactivation by
-- locking the source row through the generated_documents insert.
create function public.publish_cover_letter_for_active_cv(
  p_user_id uuid,
  p_cv_document_id uuid,
  p_candidate_profile_id uuid,
  p_job_id uuid,
  p_content text,
  p_model text,
  p_prompt_version text
) returns public.generated_documents
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  source_cv_id uuid;
  published_document public.generated_documents%rowtype;
begin
  if p_user_id is null or p_cv_document_id is null
     or p_candidate_profile_id is null or p_job_id is null
     or p_content is null or p_model is null or p_prompt_version is null then
    raise exception using errcode = '22023', message = 'Invalid cover letter publication arguments.';
  end if;

  select document.id into source_cv_id
  from public.candidate_documents as document
  join public.candidate_profiles as profile
    on profile.cv_document_id = document.id
   and profile.user_id = p_user_id
   and profile.id = p_candidate_profile_id
  where document.id = p_cv_document_id
    and document.user_id = p_user_id
    and document.document_type = 'cv'
    and document.is_active
  for update of document, profile;

  if not found then
    raise exception using errcode = 'P0001', message = 'Candidate CV changed before cover letter publication.';
  end if;

  insert into public.generated_documents (
    user_id, job_id, candidate_profile_id, document_type,
    content, model, prompt_version
  ) values (
    p_user_id, p_job_id, p_candidate_profile_id, 'cover_letter',
    p_content, p_model, p_prompt_version
  )
  returning * into published_document;

  return published_document;
end;
$function$;

revoke all on function public.publish_cover_letter_for_active_cv(uuid, uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.publish_cover_letter_for_active_cv(uuid, uuid, uuid, uuid, text, text, text)
  to service_role;

commit;
