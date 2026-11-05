set lock_timeout = '5s';
set statement_timeout = '30s';

-- Keep this preference independent of whole-document search-state writes.
alter table public.user_preferences add column if not exists employer_blocks jsonb;
alter table public.user_preferences add constraint employer_blocks_bounded_object
  check (employer_blocks is null or (jsonb_typeof(employer_blocks) = 'object' and octet_length(employer_blocks::text) <= 262144));

-- The terminal skip count is separate from ratings and failures.
alter table public.ranking_runs add column if not exists skipped_jobs integer not null default 0 check (skipped_jobs >= 0);

-- Run outcomes need their own terminal state; existing rating values remain intact.
alter type public.ranking_status add value if not exists 'skipped';
