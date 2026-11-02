<!-- Target audience: agents -->

# Provider quota accounting

The monthly entitlement counts admitted paid-provider operations. Each successful `consume_provider_quota` call adds **one** to `provider_request_usage.requests`, regardless of how many provider units that operation carries. The default free entitlement is 20 operations per UTC month.

`provider_quota_usage.units` is a separate per-provider ceiling. A JEV `/v1/jev/rank` operation charges one unit per question in its request; an LLM generation charges one unit. Do not add these unit counts together or treat them as a count of monthly operations. For example, 18 JEV units and 2 LLM units can correspond to a different number of admitted operations.

Quota is consumed before the upstream provider call. An admitted operation that later fails upstream remains counted. A rejected monthly entitlement returns `429 QUOTA_EXCEEDED`; this is a monthly limit condition, distinct from temporary provider or feed rate limits. Callers should stop the current paid-provider batch on this machine-readable error and explain that the monthly allowance is exhausted, rather than retrying every remaining job.

In production diagnostics, query entitlement, `provider_request_usage`, and `provider_quota_usage` separately for the same owner and UTC month. The quota tables are aggregate counters without per-operation timestamps or route attribution, so use sanitized request logs for chronology and route-level attribution. Never infer operation counts from provider units.
