<!-- Target audience: agents maintaining hosted JobRank -->

# Transient PostgREST clock errors

On 14 November 2026, existing Vercel logs for `/v1/me` and
`/v1/preferences/employer-blocks` showed `ENTITLEMENT_QUERY_FAILED` caused by
`PGRST303` with the exact message `JWT issued at future`. The project reported
PostgREST 14.5. Supabase documents this older-version clock-validation bug and
[recommends PostgREST 14.18 or newer](https://supabase.com/kb/troubleshooting/postgrest-error-pgrst303-jwt-issued-at-future-dc3630).

`requireActiveAccount` retries this exact entitlement read once after one second,
using a fresh query for the same authenticated user. Missing, suspended and
unverifiable entitlements still fail closed. This is a bounded recovery chance;
unit tests do not prove that the hosted clock error resolves within one second.
Do not broaden this into generic authentication retries or allow access on errors.

The infrastructure upgrade was not performed with this app fix. Inspect the
project's available upgrade, downtime estimate, warnings and backups before
planning it; Supabase's project upgrade can take the database offline.
