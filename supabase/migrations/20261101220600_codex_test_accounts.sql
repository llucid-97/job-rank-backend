begin;

-- Keep an indexed server-side expiry queue; auth metadata remains the request-time guard.
create table public.codex_test_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_id uuid not null unique,
  label text not null check (char_length(label) between 1 and 64),
  email text not null unique,
  created_at timestamptz not null default pg_catalog.now(),
  last_attempt_at timestamptz,
  expires_at timestamptz not null check (expires_at <= created_at + interval '7 days')
);

create index codex_test_accounts_expiry_idx
  on public.codex_test_accounts (expires_at, user_id);
create index codex_test_accounts_cleanup_rotation_idx
  on public.codex_test_accounts (last_attempt_at asc nulls first, expires_at, user_id);

alter table public.codex_test_accounts enable row level security;
revoke all on public.codex_test_accounts from public, anon, authenticated;
grant select, insert, update, delete on public.codex_test_accounts to service_role;

commit;
