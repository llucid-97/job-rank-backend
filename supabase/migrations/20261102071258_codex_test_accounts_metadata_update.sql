begin;

-- Admin creates apply app_metadata after inserting auth.users, so keep queue changes in that transaction too.
create or replace function codex_internal.register_codex_test_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid;
  account_label text;
  account_expires_at timestamptz;
  existing public.codex_test_accounts%rowtype;
begin
  if new.raw_app_meta_data ->> 'codex_test_account' is distinct from 'true' then
    if exists (select 1 from public.codex_test_accounts where user_id = new.id) then
      raise exception 'Cannot remove the Codex test account marker';
    end if;
    return new;
  end if;

  account_id := nullif(new.raw_app_meta_data ->> 'codex_test_account_id', '')::uuid;
  account_expires_at := nullif(new.raw_app_meta_data ->> 'codex_test_expires_at', '')::timestamptz;
  select * into existing from public.codex_test_accounts where user_id = new.id;
  if found then
    account_label := coalesce(nullif(new.raw_app_meta_data ->> 'codex_test_label', ''), existing.label);
    if account_id is distinct from existing.account_id
      or new.email is distinct from existing.email
      or account_label is distinct from existing.label
      or account_expires_at is null
      or account_expires_at > existing.expires_at
      or account_expires_at > existing.created_at + interval '7 days' then
      raise exception 'Codex test account metadata does not match its expiry record';
    end if;
    if account_expires_at < existing.expires_at then
      update public.codex_test_accounts set expires_at = account_expires_at where user_id = new.id;
    end if;
    return new;
  end if;

  account_label := new.raw_app_meta_data ->> 'codex_test_label';
  if new.email !~ '^codex-test-agent-[0-9a-f]{32}@example\.invalid$'
    or account_label !~ '^[a-z0-9][a-z0-9-]{0,63}$'
    or account_expires_at is null
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
create trigger register_codex_test_account_after_app_metadata_update
  after update of raw_app_meta_data on auth.users
  for each row execute function codex_internal.register_codex_test_account();

commit;
