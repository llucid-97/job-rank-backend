# Direct candidate document uploads

The mobile and web clients request a short-lived signed upload token from
`POST /v1/candidate/documents/uploads`, upload the bytes directly to the private
`candidate-document-staging` bucket, and finalize through
`POST /v1/candidate/documents/uploads/finalize`. The API reconstructs the staged
object path from the verified user ID and upload UUID, validates the filename,
size and file signature, extracts and normalizes text, then stores only a
Markdown object in `candidate-documents` and publishes its text through the
atomic finalization RPC, which invokes `replace_candidate_document` and marks
the upload complete in the same transaction.

The source object remains in the private staging bucket until its signed token
has expired. Each account can hold at most five unpurged upload intents,
including successful uploads while their signed tokens remain valid. Expired
intents continue to count until cleanup removes them, so cleanup delays
backpressure new uploads instead of allowing an unbounded staging backlog. A Vercel Cron job
calls the cleanup endpoint once daily and removes expired objects in batches of
100 until it approaches the function runtime budget. It also removes an
unpublished Markdown object left by a failed attempt after verifying that no
candidate document references it. Set a random `CRON_SECRET`
in the Vercel project settings; Vercel sends it as `Authorization: Bearer ...`.
Cron jobs run on all Vercel plans, with a once-daily minimum on Hobby. Staging
objects can therefore remain for up to roughly one day after their three-hour
purge time under normal cleanup operation.

## Rollout

1. Before deploying, apply all pending migrations in filename order through
   `20261030190000_claim_candidate_upload_finalize_cleanup.sql`. The upload
   migrations include `20261030103000_stage_candidate_document_uploads.sql`,
   `20261030170000_bound_candidate_upload_intents_and_finalize_retries.sql`,
   `20261030180000_allow_markdown_staging_uploads.sql`, and
   `20261030190000_claim_candidate_upload_finalize_cleanup.sql`. This creates
   the private staging bucket with a 15 MiB cap, adds the upload-intent table
   and mutually exclusive finalize/cleanup claims, and keeps the final bucket
   compatible with the currently deployed PDF/DOCX/TXT writer while also
   allowing Markdown.
2. Set `CRON_SECRET` in Vercel before deploying. The scheduled cleanup is
   registered in `vercel.json`; it only runs on production deployments.
3. Deploy the backend and client. Wait until the new backend deployment is
   fully Ready and the production alias points to it; the old multipart
   endpoint remains compatible for older clients, and the new API stores
   converted Markdown.
4. After the alias points to the new Ready deployment, wait at least 120
   seconds so requests still executing on old API instances can finish.
5. Only after that wait, apply
   `supabase/migrations/20261030200000_restrict_candidate_document_mime_types.sql`.
   It restricts new objects in `candidate-documents` to Markdown/plain text.
6. Verify one PDF upload, one replacement, and one cleanup invocation using a
   test account. Confirm the resulting `storage_path` ends in `.md` and the
   storage object content type is `text/markdown`.

Do not apply the final MIME restriction before the new backend is Ready: old
instances still write original PDF/DOCX/TXT bytes to `candidate-documents`.
After the restriction is applied, rolling back to an old backend requires
reapplying the compatibility MIME list first.

The 15 MiB application limit is lower than Supabase's project-level limit, so
the bucket limit must be present before issuing signed upload tokens. Supabase
recommends resumable uploads above 6 MiB; this initial client path uses standard
signed uploads and should be upgraded to resumable transfer if larger files
become common.

## Failure handling

The signed token can be used without further authentication and is valid for two
hours. It is bound to a random owner-scoped path, does not permit overwrite, and
is never returned in application logs. Finalization ignores caller-supplied
storage paths. A content signature check rejects MIME/extension spoofing before
the parser runs. Staging remains private and the cleanup job uses the Storage
API to remove objects; SQL must not delete Storage object metadata directly.

Finalization uses the upload UUID as the document ID. A retried request after a
successful commit returns the already-published row rather than creating a
second revision. Finalization and cleanup hold mutually exclusive, expiring
claims. An ambiguous publication response keeps its finalization claim until
the lease expires; cleanup cannot remove the staged or unreferenced Markdown
object while the database outcome is uncertain. Expired failed uploads are
removed by the claim-protected cleanup job.
