begin;

-- Apply analysis-only snapshots to existing owner associations, never shared jobs.
create function public.save_job_analyses(p_user_id uuid, p_source text, p_jobs jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  expected_count integer;
  updated_count integer;
  result jsonb;
begin
  if pg_catalog.jsonb_typeof(p_jobs) <> 'array' then
    raise exception 'Analysis jobs must be an array';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':jobs', 0));

  with input as materialized (
    select value as item, ordinality
    from pg_catalog.jsonb_array_elements(p_jobs) with ordinality
  ), targets as materialized (
    select input.item, input.ordinality, j.id as job_id, j.external_id
    from input
    join public.jobs j on j.source = input.item->>'source' and j.external_id = input.item->>'id'
    join public.user_jobs uj on uj.job_id = j.id and uj.user_id = p_user_id
    where p_source = 'configured' or j.source = p_source
  )
  select
    (select pg_catalog.count(*)::integer from input),
    (select pg_catalog.count(*)::integer from targets)
  into expected_count, updated_count;

  if expected_count <> updated_count then
    raise exception 'WORKSPACE_ANALYSIS_CONFLICT';
  end if;
  if expected_count = 0 then
    return '[]'::jsonb;
  end if;

  with input as materialized (
    select value as item, ordinality
    from pg_catalog.jsonb_array_elements(p_jobs) with ordinality
  ), targets as materialized (
    select input.item, input.ordinality, j.id as job_id, j.external_id
    from input
    join public.jobs j on j.source = input.item->>'source' and j.external_id = input.item->>'id'
    join public.user_jobs uj on uj.job_id = j.id and uj.user_id = p_user_id
    where p_source = 'configured' or j.source = p_source
  ), updated as (
    update public.user_jobs uj
    set workspace_data = coalesce(uj.workspace_data, '{}'::jsonb)
      || pg_catalog.jsonb_build_object(
        'prescriptiveScore', targets.item->'prescriptiveScore',
        'summaryJson', targets.item->'summaryJson',
        'llmVerifiedLocation', targets.item->'llmVerifiedLocation',
        'locationMismatch', targets.item->'locationMismatch'
      )
      || pg_catalog.jsonb_build_object(
        'otherData',
        coalesce((
          select pg_catalog.jsonb_object_agg(old.key, old.value)
          from pg_catalog.jsonb_each(
            case when pg_catalog.jsonb_typeof(uj.workspace_data->'otherData') = 'object'
              then uj.workspace_data->'otherData' else '{}'::jsonb end
          ) as old(key, value)
          where not (
            old.key in ('processing_error', 'prescriptive_version', 'rated_at', 'search_constraints',
              'job_input_identity', 'candidate_score_projection_identity')
            or left(old.key, 4) = 'jev_'
            or left(old.key, 7) = 'rating_'
            or left(old.key, 18) = 'candidate_profile_'
            or left(old.key, 18) = 'ranking_classifier'
          )
        ), '{}'::jsonb)
        || coalesce((
          select pg_catalog.jsonb_object_agg(incoming.key, incoming.value)
          from pg_catalog.jsonb_each(
            case when pg_catalog.jsonb_typeof(targets.item->'otherData') = 'object'
              then targets.item->'otherData' else '{}'::jsonb end
          ) as incoming(key, value)
          where incoming.key in ('processing_error', 'prescriptive_version', 'rated_at', 'search_constraints',
              'job_input_identity', 'candidate_score_projection_identity')
            or left(incoming.key, 4) = 'jev_'
            or left(incoming.key, 7) = 'rating_'
            or left(incoming.key, 18) = 'candidate_profile_'
            or left(incoming.key, 18) = 'ranking_classifier'
        ), '{}'::jsonb)
      ),
      updated_at = pg_catalog.now()
    from targets
    where uj.user_id = p_user_id and uj.job_id = targets.job_id
    returning targets.ordinality, targets.external_id, targets.job_id
  )
  select pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('external_id', updated.external_id, 'id', updated.job_id)
    order by updated.ordinality
  ), pg_catalog.count(*)::integer
  into result, updated_count
  from updated;

  if updated_count <> expected_count then
    raise exception 'WORKSPACE_ANALYSIS_CONFLICT';
  end if;
  return coalesce(result, '[]'::jsonb);
end;
$$;

revoke all on function public.save_job_analyses(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_job_analyses(uuid, text, jsonb) to service_role;

commit;
