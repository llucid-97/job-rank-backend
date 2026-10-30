begin;

-- Rich search snapshots remain private to the existing owner-scoped preferences row.
alter table public.user_preferences add column if not exists search_state jsonb;
alter table public.user_preferences add constraint search_state_is_bounded_object
  check (search_state is null or (jsonb_typeof(search_state) = 'object'
    and octet_length(search_state::text) <= 1048576));

-- Score observations survive removing a saved job; no CV or posting content is stored.
create table public.user_match_observations (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  candidate_id text not null check (candidate_id ~ '^[0-9a-f]{64}$'),
  pipeline_version text not null check (octet_length(pipeline_version) between 1 and 256),
  resolved_model text not null check (octet_length(resolved_model) between 1 and 256),
  source text not null check (octet_length(source) between 1 and 300),
  job_id text not null check (octet_length(job_id) between 1 and 1500),
  score double precision not null check (score >= 0 and score <= 1),
  rated_at timestamptz not null,
  unique (user_id, candidate_id, pipeline_version, resolved_model, source, job_id)
);
alter table public.user_match_observations enable row level security;
revoke all on public.user_match_observations from public, anon, authenticated;
grant select, insert, update, delete on public.user_match_observations to service_role;
grant usage, select on sequence public.user_match_observations_id_seq to service_role;

-- Pick the newest observed model and page one owner's cohort without offset truncation.
create index user_match_observations_latest_model_idx
  on public.user_match_observations (user_id, candidate_id, pipeline_version, rated_at desc, id desc)
  include (resolved_model);
create index user_match_observations_cohort_page_idx
  on public.user_match_observations (user_id, candidate_id, pipeline_version, resolved_model, id);

-- A late replay cannot overwrite a newer rating or reactivate an older model cohort.
create function public.save_match_observations(
  p_user_id uuid, p_candidate_id text, p_pipeline_version text,
  p_resolved_model text, p_scores jsonb
) returns integer language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  -- Reject the entire batch unless each posting currently belongs to this owner.
  if exists (
    select 1 from pg_catalog.jsonb_to_recordset(p_scores) as item(source text, job_id text)
    where not exists (
      select 1 from public.user_jobs uj join public.jobs j on j.id = uj.job_id
      where uj.user_id = p_user_id and j.source = item.source and j.external_id = item.job_id
    )
  ) then
    raise exception using errcode = 'P0001', message = 'MATCH_JOB_NOT_IN_WORKSPACE';
  end if;
  with written as (
    insert into public.user_match_observations as previous
      (user_id, candidate_id, pipeline_version, resolved_model, source, job_id, score, rated_at)
    select p_user_id, p_candidate_id, p_pipeline_version, p_resolved_model,
      item.source, item.job_id, item.score, item.rated_at
    from pg_catalog.jsonb_to_recordset(p_scores)
      as item(source text, job_id text, score double precision, rated_at timestamptz)
    on conflict (user_id, candidate_id, pipeline_version, resolved_model, source, job_id)
    do update set score = excluded.score, rated_at = excluded.rated_at
      where previous.rated_at < excluded.rated_at
    returning 1
  )
  select count(*)::integer into changed from written;
  return changed;
end;
$$;
revoke all on function public.save_match_observations(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.save_match_observations(uuid, text, text, text, jsonb) to service_role;

commit;
