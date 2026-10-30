import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { supabaseAdmin } from "../src/config/supabase.js";
import { getMe } from "../src/modules/account/account.controller.js";
import {
  getPlans,
  getSubscription,
} from "../src/modules/billing/billing.controller.js";

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);

afterEach(() => {
  supabaseAdmin.from = originalFrom as any;
});

const spendDisclosure = {
  aiSpendLimitEnforced: false,
  aiSpendLimitNotice: "Target only; not an enforced hard spending cap.",
};

function response() {
  return {
    body: undefined as any,
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
  } as any;
}

function stubQueries(rows: Record<string, unknown>) {
  supabaseAdmin.from = ((table: string) => {
    const query: any = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      single: async () => ({ data: rows[table], error: null }),
      maybeSingle: async () => ({ data: rows[table], error: null }),
      then: (resolve: (result: unknown) => unknown) =>
        Promise.resolve({ data: rows[table], error: null }).then(resolve),
    };
    return query;
  }) as any;
}

test("account/me preserves the spend target and discloses that it is not enforced", async () => {
  stubQueries({
    profiles: { display_name: "Ada", avatar_url: null, created_at: "2026-01-01" },
    user_roles: { role: "user" },
    user_entitlements: {
      plan: "free",
      account_status: "active",
      monthly_request_limit: 20,
      ai_cost_limit_usd: 1,
    },
  });
  const result = response();

  await getMe({ auth: { userId: "user-1", email: "ada@example.test" } } as any, result, (error: unknown) => { throw error; });

  assert.equal(result.body.data.monthlySpendLimitUsd, 1);
  assert.deepEqual(
    { aiSpendLimitEnforced: result.body.data.aiSpendLimitEnforced, aiSpendLimitNotice: result.body.data.aiSpendLimitNotice },
    spendDisclosure,
  );
});

test("plan and current-subscription billing plan responses disclose spend target semantics", async () => {
  const plan = {
    code: "free",
    ai_cost_limit_usd: 1,
    monthly_request_limit: 20,
  };
  stubQueries({
    billing_plans: [plan],
    subscriptions: {
      id: "subscription-1",
      billing_plans: plan,
    },
  });

  const plansResponse = response();
  await getPlans({} as any, plansResponse);
  assert.equal(plansResponse.body.data[0].ai_cost_limit_usd, 1);
  assert.deepEqual(
    {
      aiSpendLimitEnforced: plansResponse.body.data[0].aiSpendLimitEnforced,
      aiSpendLimitNotice: plansResponse.body.data[0].aiSpendLimitNotice,
    },
    spendDisclosure,
  );

  const subscriptionResponse = response();
  await getSubscription({ auth: { userId: "user-1" } } as any, subscriptionResponse);
  assert.equal(subscriptionResponse.body.data.billing_plans.ai_cost_limit_usd, 1);
  assert.deepEqual(
    {
      aiSpendLimitEnforced: subscriptionResponse.body.data.billing_plans.aiSpendLimitEnforced,
      aiSpendLimitNotice: subscriptionResponse.body.data.billing_plans.aiSpendLimitNotice,
    },
    spendDisclosure,
  );
});
