-- Direct-to-Storage candidate uploads stay private and are retained only long
-- enough to outlive the signed upload token. Final candidate objects are Markdown.
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('candidate-document-staging', 'candidate-document-staging', false, 15728640,
    array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']),
  ('candidate-documents', 'candidate-documents', false, 4194304,
    array['text/markdown', 'text/plain'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.candidate_document_upload_intents (
  id uuid primary key,
  -- Keep the owner UUID after account deletion so the cleanup worker can still
  -- reconstruct and remove the private staging object.
  user_id uuid not null,
  purge_after timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists candidate_document_upload_intents_purge_after_idx
  on public.candidate_document_upload_intents (purge_after);

alter table public.candidate_document_upload_intents enable row level security;
revoke all on public.candidate_document_upload_intents from anon, authenticated;
grant all on public.candidate_document_upload_intents to service_role;

-- Supabase projects may have broad own-folder policies. Restrictive rules make
-- both private buckets backend-write-only even when permissive policies exist.
create policy candidate_staging_backend_select
on storage.objects as restrictive for select to anon, authenticated
using (bucket_id <> 'candidate-document-staging');
create policy candidate_staging_backend_insert
on storage.objects as restrictive for insert to anon, authenticated
with check (bucket_id <> 'candidate-document-staging');
create policy candidate_staging_backend_update
on storage.objects as restrictive for update to anon, authenticated
using (bucket_id <> 'candidate-document-staging')
with check (bucket_id <> 'candidate-document-staging');
create policy candidate_staging_backend_delete
on storage.objects as restrictive for delete to anon, authenticated
using (bucket_id <> 'candidate-document-staging');

commit;
