<!-- Target audience: agents -->

# Provider quota accounting

The monthly entitlement counts admitted paid-provider operations. Each successful `consume_provider_quota` call adds **one** to `provider_request_usage.requests`, regardless of how many provider units that operation carries. The default free entitlement is 20 operations per UTC month. When server-side `ALPHA_PREMIUM_ACCESS=true`, `record_alpha_provider_usage` bypasses monthly ceilings while continuing to record the same per-user, per-provider, per-month counters. The setting defaults to false.

`provider_quota_usage.units` is a separate per-provider ceiling. A JEV `/v1/jev/rank` operation charges one unit per question in its request; an LLM generation charges one unit. Do not add these unit counts together or treat them as a count of monthly operations. For example, 18 JEV units and 2 LLM units can correspond to a different number of admitted operations.

Quota is consumed before the upstream provider call. An admitted operation that later fails upstream remains counted. A rejected monthly entitlement returns `429 QUOTA_EXCEEDED`; this is a monthly limit condition, distinct from temporary provider or feed rate limits. Callers should stop the current paid-provider batch on this machine-readable error and explain that the monthly allowance is exhausted, rather than retrying every remaining job.

These counters support per-user usage distribution by provider and month. They are not token, cost, prompt, or per-operation records.

In production diagnostics, query entitlement, `provider_request_usage`, and `provider_quota_usage` separately for the same owner and UTC month. The quota tables are aggregate counters without per-operation timestamps or route attribution, so use sanitized request logs for chronology and route-level attribution. Never infer operation counts from provider units.

For a monthly usage distribution that includes active accounts with zero usage, group the owner/month counters by the stored tier. Exclude reserved Codex test accounts using the server-owned `raw_app_meta_data` marker:

```sql
with current_month as (
  select pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'UTC')::date as month_utc
)
select
  entitlement.user_id,
  entitlement.plan as stored_plan,
  current_month.month_utc,
  entitlement.monthly_request_limit as stored_monthly_limit,
  coalesce(request_usage.requests, 0) as admitted_operations,
  coalesce(sum(quota_usage.units) filter (where quota_usage.kind = 'jev'), 0) as jev_units,
  coalesce(sum(quota_usage.units) filter (where quota_usage.kind = 'llm'), 0) as llm_units,
  coalesce(sum(quota_usage.units) filter (where quota_usage.kind = 'jobsdb'), 0) as jobsdb_units
from public.user_entitlements as entitlement
join auth.users as account on account.id = entitlement.user_id
cross join current_month
left join public.provider_request_usage as request_usage
  on request_usage.user_id = entitlement.user_id
  and request_usage.month_utc = current_month.month_utc
left join public.provider_quota_usage as quota_usage
  on quota_usage.user_id = entitlement.user_id
  and quota_usage.month_utc = current_month.month_utc
where account.raw_app_meta_data ->> 'codex_test_account' is distinct from 'true'
group by entitlement.user_id, entitlement.plan, current_month.month_utc,
  entitlement.monthly_request_limit, request_usage.requests;
```

During alpha, stored tier and stored limit remain unchanged; the separate public access contract reports effective premium access and a null effective monthly limit.

Alpha ranking uses the same admitted-operation counters: decision requests charge `jev` units per question, and chat ranking requests charge one `llm` unit. Successful ranking responses also emit the fixed `ranking.provider.usage` event with the account ID, requested model, provider-resolved model, question count, and any bounded token counts the provider actually reports. A missing token count is null, not zero; logs are operational telemetry, not durable billing records or exact spend. These events do not contain candidate, job, prompt, answer or credential text.

The `/v1/jev/rank` name is retained for older clients, but the server allowlist routes Jev to TypeSafe, Elephant and d1-ultra to OpenRouter Decisions, and the three GPT options to OpenRouter chat with server-owned reasoning effort and output cap. Chat probabilities are the model's own estimates, not calibrated decision-model probabilities. The strict parser requires every requested question and category; it does not fill missing results. The `searchState.rankingModel` ID is optional for old saved states. `providerPolicyRevision` must change whenever this adapter's scoring prompt or reasoning settings change, so score histories do not combine incomparable pipelines.
