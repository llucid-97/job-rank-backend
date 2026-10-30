# Isolated PDF extraction

PDF extraction can run in a per-document Vercel Sandbox rather than in the API
function. The API keeps PDF uploads and persistence in their existing flows;
DOCX and text extraction remain local. The isolated worker uses a one-vCPU
sandbox (2 GiB RAM), denies outbound network access, has a 45-second session
timeout, accepts at most 15 MiB of input, and returns at most 4 MiB of text.
The per-request sandbox is non-persistent and deleted after extraction.

## Create the parser snapshot

Use a Vercel project/account that owns the JobRank API project. The seed
sandbox installs only pinned public parser packages and this repository's
extractor script. It must never receive a candidate PDF or production secret.
The seed uses outbound network access only to download those packages; normal
PDF sandboxes use `deny-all`.

From PowerShell, run these commands from this checkout's repository root:

```powershell
Set-Location C:\Users\ihexx\projects\job-rank-backend\.worktrees\pdf-sandbox-extraction
vercel link
vercel env pull
npm run sandbox:pdf:snapshot
```

The final command prints a line in this form; the value after the colon is the
snapshot ID:

```text
Created clean PDF parser snapshot: snap_...
```

Set `PDF_SANDBOX_SNAPSHOT_ID` to that value
in the Vercel project environment before routing PDF extraction through this
service. The script sets a 30-day snapshot expiry; rerun it after expiry or
when upgrading the pinned parser packages. It uses the Vercel Sandbox Hobby
included usage when available; Vercel pauses new sandbox creation after Hobby
quotas are exhausted.

Local development uses the linked project's `VERCEL_OIDC_TOKEN` from
`.env.local`. Production uses Vercel's project OIDC authentication when
Secure Backend Access is enabled. Do not add a long-lived Vercel access token
to the sandbox or pass application secrets into `Sandbox.create()`.

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
