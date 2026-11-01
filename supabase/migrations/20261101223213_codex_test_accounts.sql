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

create schema if not exists codex_internal;
revoke all on schema codex_internal from public, anon, authenticated;

-- Auth creation and queue registration commit together, so a failed client cannot orphan a test user.
create function codex_internal.register_codex_test_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid;
  account_label text;
  account_expires_at timestamptz;
begin
  -- Only admin-owned app metadata may enter this queue; user-editable metadata never grants test status.
  if new.raw_app_meta_data ->> 'codex_test_account' is distinct from 'true' then
    return new;
  end if;

  account_id := (new.raw_app_meta_data ->> 'codex_test_account_id')::uuid;
  account_label := new.raw_app_meta_data ->> 'codex_test_label';
  account_expires_at := (new.raw_app_meta_data ->> 'codex_test_expires_at')::timestamptz;
  if new.email !~ '^codex-test-agent-[0-9a-f]{32}@example\.invalid$'
    or account_label !~ '^[a-z0-9][a-z0-9-]{0,63}$'
    or account_expires_at <= new.created_at
    or account_expires_at > new.created_at + interval '7 days' then
    raise exception 'Invalid Codex test account registration';
  end if;

  insert into public.codex_test_accounts (user_id, account_id, label, email, created_at, expires_at)
  values (new.id, account_id, account_label, new.email, new.created_at, account_expires_at);
  return new;
end;
$$;

revoke all on function codex_internal.register_codex_test_account() from public, anon, authenticated, service_role;
create trigger register_codex_test_account_after_auth_insert
  after insert on auth.users
  for each row execute function codex_internal.register_codex_test_account();

commit;
