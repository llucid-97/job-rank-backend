---
name: jobrank-codex-test-accounts
description: "Create and use isolated seven-day JobRank Codex test accounts for hosted authentication and app-flow testing."
---

# JobRank Codex Test Accounts

Use this when a JobRank task needs a real hosted sign-in to verify the deployed app. Read the backend repository's `AGENTS.md` and current `scripts/create-codex-test-account.mjs` before provisioning.

Run the backend script from a trusted backend checkout with its dependencies installed and `SUPABASE_URL` plus `SUPABASE_SECRET_KEY` available from the trusted environment (normally the local `.env`). Never copy either key into the frontend build, command output, test artifacts, or chat. Provision with:

```sh
node scripts/create-codex-test-account.mjs <short-agent-label>
```

The script creates a random password for an `@example.invalid` identity, marks it using server-owned Supabase `app_metadata`, records an expiry no more than seven days out, and writes credentials under `~/.codex/jobrank-test-accounts/` with directory mode `0700` and file mode `0600`. Its output gives the credential file path and expiry; read the file only when logging into the hosted app, and never print or copy the password into a report.

To register a previously created synthetic account after the lifecycle migration is deployed, run `node scripts/create-codex-test-account.mjs adopt <user-uuid>`. Adoption verifies the reserved email pattern and trusted metadata, then copies the existing expiry to the cleanup queue without extending it.

Use the account only for the requested JobRank test. Keep test profile data fictional and avoid paid provider calls unless the parent task specifically needs them. The backend rejects test-account requests at expiry; a daily Vercel Cron removes expired Auth users and their files from both candidate storage buckets. A cleanup failure leaves the account queued for retry while API access remains blocked by the expiry check.

Never make test accounts with real email addresses or real people's data. Do not weaken public signup, use user-editable metadata as an expiry authority, put secrets in the frontend, or change the seven-day limit without explicit instruction. Confirm the test account identity and expiry before using it, and report the account ID (not credentials) when handing off.
