<!-- Audience: agents -->

# Candidate skills profile generation

The persisted profile endpoint validates OpenRouter output against `resources/skills.json` before storing it. Its response budget is 8192 tokens because the profile includes both skills and behavioral sections. Check `finish_reason` before inspecting the completion text: a `length` result is incomplete even if its visible text happens to parse as JSON.

Return truncated, empty, malformed, or schema-invalid bodies from successful provider HTTP responses as safe 502 errors. Non-2xx provider responses retain their existing generic error mapping. Keep provider completion text, generated profile values, and Ajv error details out of logs and client messages; log only a stable code and counts needed to diagnose the failure. Do not automatically retry a paid generation request. Keep the existing cache identity tied to the CV hash, schema hash, and policy version.

The generation tests belong in the local ignored `.codex-tests/` directory until an explicit PR review deliberately promotes them. They must use synthetic candidate text and local Supabase/provider mocks only.

Vercel can classify structured Pino stdout as `info` even when its JSON level is an error. Query the affected route across levels when investigating failures; do not restore raw exception or provider-body logging to recover diagnostics.
