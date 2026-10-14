-- Target audience: backend maintainers and agents.
-- Store one account-owned onboarding draft; writes remain behind the validated API.
create table public.onboarding_drafts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  draft jsonb not null check (jsonb_typeof(draft) = 'object'),
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

alter table public.onboarding_drafts enable row level security;
revoke all on table public.onboarding_drafts from anon, authenticated;
grant select on table public.onboarding_drafts to authenticated;
grant select, insert, update, delete on table public.onboarding_drafts to service_role;
create policy onboarding_drafts_read_own
  on public.onboarding_drafts for select to authenticated
  using ((select auth.uid()) = user_id);
