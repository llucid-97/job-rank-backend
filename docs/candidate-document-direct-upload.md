# Direct candidate document uploads

The mobile and web clients request a short-lived signed upload token from
`POST /v1/candidate/documents/uploads`, upload the bytes directly to the private
`candidate-document-staging` bucket, and finalize through
`POST /v1/candidate/documents/uploads/finalize`. The API reconstructs the staged
object path from the verified user ID and upload UUID, validates the filename,
size and file signature, extracts and normalizes text, then stores only a
Markdown object in `candidate-documents` and publishes its text through
`replace_candidate_document`.

The source object remains in the private staging bucket until its signed token
has expired. A Vercel Cron job calls the cleanup endpoint once daily and removes
up to 1,000 expired objects per run in batches of 100. Set a random `CRON_SECRET` in the Vercel
project settings; Vercel sends it as `Authorization: Bearer ...`. Cron jobs run
on all Vercel plans, with a once-daily minimum on Hobby. Staging objects can
therefore remain for up to roughly one day after their three-hour purge time.

## Rollout

1. Apply `supabase/migrations/20261030103000_stage_candidate_document_uploads.sql`.
   It creates the private staging bucket with a 15 MiB cap, restricts direct
   client access, limits final objects to Markdown/plain text, and creates the
   service-role-only upload-intent table.
2. Set `CRON_SECRET` in Vercel before deploying. The scheduled cleanup is
   registered in `vercel.json`; it only runs on production deployments.
3. Deploy the backend and client together. The old multipart endpoint remains
   compatible for older clients, but it also stores converted Markdown now.
4. Verify one PDF upload, one replacement, and one cleanup invocation using a
   test account. Confirm the resulting `storage_path` ends in `.md` and the
   storage object content type is `text/markdown`.

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
second revision. If publication fails after the normalized Markdown object is
uploaded, the existing controller's compensation policy removes it only after
a confirmed database rejection; uncertain outcomes preserve it for
reconciliation.
