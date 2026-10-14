<!-- Target audience: agents and backend maintainers. -->
# Onboarding API

`GET /v1/onboarding` returns `{data: {draft, revision}}`; a missing draft is `{draft: null, revision: 0}`. `PUT /v1/onboarding` accepts `{draft, expectedRevision}` and returns the saved draft/revision. Revision mismatch returns `409 ONBOARDING_CONFLICT`. Draft source document IDs must identify active documents owned by the authenticated account.

`POST /v1/onboarding/assist` accepts `{draft, mode}` where mode is `background`, `lanes`, `interview`, or `review`. Suggestions are validated against a strict schema and tailoring evidence must quote current user-provided text.

`POST /v1/onboarding/assess-jobs` accepts `{jobIds, expectedRevision}` for up to 12 saved jobs and requires the exact revision of a confirmed account draft. It assesses every lane independently against each job without changing candidate scoring. The response is `{data: {revision, results: [{job_id, lane_assessments: [{lane_id, fit, reason, unknowns}]}]}}`, where `fit` is `fit`, `uncertain`, or `not_fit`. Missing job details force a positive fit to `uncertain`; schema, revision, ownership, or freshness failures do not return partial results.

For a local preview, copy `.env.example` to the ignored `.env` file and fill in valid local Supabase and provider credentials. Then use `HOST=127.0.0.1 PORT=5193 npm run dev` for TypeScript watch mode, or run `npm ci`, `npm run build`, then `HOST=127.0.0.1 PORT=5193 npm start` for the built server. Both commands bind only to loopback when these variables are set.
