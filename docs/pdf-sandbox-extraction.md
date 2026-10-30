# Isolated PDF extraction

PDF extraction can run in a per-document Vercel Sandbox rather than in the API
function. The API keeps PDF uploads and persistence in their existing flows;
DOCX and text extraction remain local. The isolated worker uses a one-vCPU
sandbox (2 GiB RAM), denies outbound network access, has a 45-second session
timeout, accepts at most 15 MiB of input, and returns at most 4 MiB of text.
The per-request sandbox is non-persistent and deleted after extraction. The
seed bootstrap applies and validates the repository's PDF.js resource patch
inside the snapshot before it can be used for candidate documents.

## Create the parser snapshot

Use a Vercel project/account that owns the JobRank API project. The seed
sandbox installs only pinned public parser packages and this repository's
extractor and PDF.js resource-patch scripts. It must never receive a candidate
PDF or production secret. The bootstrap applies the patch, then runs it a
second time to validate the already patched worker and parser before snapshot.
The seed uses outbound network access only to download those packages; normal
PDF sandboxes use `deny-all`.

The bootstrap script uses the Vercel CLI's existing authenticated session
directly. It does not read or export CLI credentials, and it does not require
`vercel link` or `vercel env pull`. From PowerShell, run:

```powershell
Set-Location C:\Users\ihexx\projects\job-rank-backend\.worktrees\pdf-sandbox-extraction
.\scripts\create-pdf-sandbox-snapshot.ps1
```

The script creates a short-lived, non-persistent seed sandbox with outbound
access only for installing pinned packages, copies in and patches the worker
and parser, takes a 30-day snapshot, and removes the seed sandbox. It prints a
line in this form;
the value after the colon is the snapshot ID:

```text
Created clean PDF parser snapshot: snap_...
```

Set `PDF_SANDBOX_SNAPSHOT_ID` to that value
in the Vercel project environment before routing PDF extraction through this
service. The script sets a 30-day snapshot expiry; rerun it after expiry or
when upgrading the pinned parser packages. It uses the Vercel Sandbox Hobby
included usage when available; Vercel pauses new sandbox creation after Hobby
quotas are exhausted.

The CLI uses its already-authenticated Vercel session for the bootstrap
commands. The sandbox receives no CLI credentials or application secrets.
Vercel documents that OIDC authentication is automatic in production on
Vercel; the Sandbox SDK can use the deployment-provided token without a stored
access token. This has not been exercised against a live deployment in this
change.

Worker exit code 1 reports an unparseable PDF (422), exit code 2 reports an
invalid PDF input (422), and exit code 3 reports a parser/output resource limit
(413). Sandbox OOM and timeout terminations also map to 413. DOCX/TXT behavior
is unchanged.

## Integration point

Call `extractPdfTextInSandbox(buffer)` only for PDFs. Keep DOCX and TXT routed
through the existing in-process extractor. The function fails closed when
`PDF_SANDBOX_SNAPSHOT_ID` is absent; it does not fall back to local PDF.js.

The current direct-upload finalizer still materializes the staged 15 MiB file
as a Buffer before calling the extractor. Sandbox isolation bounds parser
memory, but not that API-side upload buffer. If the upload limit grows, fetch
the staged object directly from Supabase from inside the sandbox with a
short-lived object URL and a tightly scoped network policy instead of relaying
the full bytes through the API process.
