begin;

alter table public.candidate_profiles
  add column revision integer,
  add column is_current boolean;

-- A previous content-based unique constraint would prevent retaining later edits
-- to the same CV and schema. Remove only a constraint on those exact columns.
do $$
declare
  constraint_name text;
  index_name text;
begin
  for constraint_name in
    select c.conname
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.candidate_profiles'::regclass
      and c.contype = 'u'
      and (
        select pg_catalog.array_agg(a.attname order by a.attname)
        from pg_catalog.unnest(c.conkey) with ordinality as k(attnum, ord)
        join pg_catalog.pg_attribute a
          on a.attrelid = c.conrelid and a.attnum = k.attnum
      ) = array['cv_hash', 'policy_version', 'schema_hash', 'user_id']::name[]
  loop
    execute pg_catalog.format(
      'alter table public.candidate_profiles drop constraint %I',
      constraint_name
    );
  end loop;
  -- Some earlier installs may have created the same uniqueness as a plain index.
  for index_name in
    select index_class.relname
    from pg_catalog.pg_index as index_row
    join pg_catalog.pg_class as index_class
      on index_class.oid = index_row.indexrelid
    where index_row.indrelid = 'public.candidate_profiles'::regclass
      and index_row.indisunique
      and not index_row.indisprimary
      and index_row.indexprs is null
      and index_row.indpred is null
      and not exists (
        select 1 from pg_catalog.pg_constraint as constraint_row
        where constraint_row.conindid = index_row.indexrelid
      )
      and (
        select pg_catalog.array_agg(attribute.attname order by attribute.attname)
        from pg_catalog.unnest(index_row.indkey) as key(attnum)
        join pg_catalog.pg_attribute as attribute
          on attribute.attrelid = index_row.indrelid
         and attribute.attnum = key.attnum
      ) = array['cv_hash', 'policy_version', 'schema_hash', 'user_id']::name[]
  loop
    execute pg_catalog.format('drop index public.%I', index_name);
  end loop;
end;
$$;

with ranked_profiles as (
  select id,
         row_number() over (
           partition by user_id, cv_document_id
           order by created_at desc, id desc
         ) as position,
         count(*) over (
           partition by user_id, cv_document_id
           order by created_at, id
           rows between unbounded preceding and current row
         ) as revision
  from public.candidate_profiles
)
update public.candidate_profiles as profile
set revision = ranked_profiles.revision::integer,
    is_current = ranked_profiles.position = 1
from ranked_profiles
where profile.id = ranked_profiles.id;

alter table public.candidate_profiles
  alter column revision set not null,
  alter column revision set default 1,
  alter column is_current set not null,
  alter column is_current set default true,
  add constraint candidate_profiles_revision_positive check (revision > 0);

create unique index candidate_profiles_one_current_per_cv
  on public.candidate_profiles (user_id, cv_document_id)
  where is_current;

create or replace function public.publish_candidate_profile(
  p_user_id uuid,
  p_cv_document_id uuid,
  p_expected_profile_id uuid,
  p_cv_hash text,
  p_schema_hash text,
  p_policy_version text,
  p_skills_profile jsonb,
  p_model text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  document_is_active boolean;
  current_profile_id uuid;
  next_revision integer;
  published_profile public.candidate_profiles%rowtype;
begin
  -- Serializes publication with CV replacement and other profile writes.
  select d.is_active into document_is_active
  from public.candidate_documents as d
  where d.id = p_cv_document_id
    and d.user_id = p_user_id
    and d.document_type = 'cv'
  for update;

  if document_is_active is distinct from true then
    raise exception 'candidate context changed' using errcode = 'P0001';
  end if;

  select p.id into current_profile_id
  from public.candidate_profiles as p
  where p.user_id = p_user_id
    and p.cv_document_id = p_cv_document_id
    and p.is_current
  for update;

  if current_profile_id is distinct from p_expected_profile_id then
    raise exception 'candidate context changed' using errcode = 'P0001';
  end if;

  select coalesce(max(p.revision), 0) + 1 into next_revision
  from public.candidate_profiles as p
  where p.user_id = p_user_id and p.cv_document_id = p_cv_document_id;

  update public.candidate_profiles
  set is_current = false
  where user_id = p_user_id and cv_document_id = p_cv_document_id and is_current;

  insert into public.candidate_profiles (
    user_id, cv_document_id, cv_hash, schema_hash, policy_version,
    skills_profile, model, revision, is_current
  ) values (
    p_user_id, p_cv_document_id, p_cv_hash, p_schema_hash, p_policy_version,
    p_skills_profile, p_model, next_revision, true
  )
  returning * into published_profile;

  return pg_catalog.to_jsonb(published_profile);
end;
$function$;

revoke all on function public.publish_candidate_profile(uuid, uuid, uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.publish_candidate_profile(uuid, uuid, uuid, text, text, text, jsonb, text)
  to service_role;

commit;
