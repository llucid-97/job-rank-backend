import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: new URL("./fixtures/no-runtime-env", import.meta.url).pathname,
  NODE_ENV: "test",
  FRONTEND_URL: "http://localhost:3001",
  SUPABASE_URL: "https://synthetic.invalid",
  SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable",
  SUPABASE_SECRET_KEY: "synthetic-secret",
  OPENROUTER_API_KEY: "synthetic",
  JOBSDB_API_KEY: "synthetic",
  TYPESAFE_API_KEY: "synthetic",
  SKILLS_JSON_GENERATION_MODEL: "synthetic-model",
  COVER_LETTER_CODEX_MODEL: "synthetic-model",
  STRIPE_SECRET_KEY: "sk_test_synthetic",
});

const { supabaseAdmin } = await import("../src/config/supabase.js");
const { getStripe } = await import("../src/config/stripe.js");
const { processStripeEvent } = await import(
  "../src/modules/billing/stripe-webhook.service.js"
);

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const stripe = getStripe();
const originalRetrieve = stripe.subscriptions.retrieve.bind(
  stripe.subscriptions,
);

afterEach(() => {
  supabaseAdmin.from = originalFrom as typeof supabaseAdmin.from;
  stripe.subscriptions.retrieve = originalRetrieve;
});

/** Model both an old event snapshot and the current state returned by Stripe. */
function subscription(status: "active" | "canceled") {
  return {
    id: "sub-synthetic",
    customer: "cus-synthetic",
    metadata: { user_id: "user-synthetic" },
    status,
    cancel_at_period_end: false,
    current_period_start: 1_800_000_000,
    current_period_end: 1_802_592_000,
    trial_start: null,
    trial_end: null,
    canceled_at: status === "canceled" ? 1_800_100_000 : null,
    ended_at: status === "canceled" ? 1_800_100_000 : null,
    items: { data: [{ price: { id: "price-synthetic" } }] },
  } as any;
}

/** Record webhook writes while returning only the plan row needed by synchronization. */
function installDatabase(
  writes: Array<{ table: string; action: string; value: any }>,
) {
  supabaseAdmin.from = ((table: string) => {
    const query: any = {
      select() {
        return query;
      },
      eq() {
        return query;
      },
      maybeSingle: async () => ({
        data: {
          id: "plan-synthetic",
          code: "pro",
          monthly_request_limit: 200,
          ai_cost_limit_usd: 10,
        },
        error: null,
      }),
      upsert: async (value: any) => {
        writes.push({ table, action: "upsert", value });
        return { error: null };
      },
      update: (value: any) => {
        writes.push({ table, action: "update", value });
        return {
          eq: async () => ({ error: null }),
        };
      },
    };
    return query;
  }) as typeof supabaseAdmin.from;
}

test("stale subscription event syncs Stripe's current canceled state", async () => {
  const writes: Array<{ table: string; action: string; value: any }> = [];
  const retrieveCalls: string[] = [];
  installDatabase(writes);
  stripe.subscriptions.retrieve = (async (id: string) => {
    retrieveCalls.push(id);
    return subscription("canceled");
  }) as typeof stripe.subscriptions.retrieve;

  await processStripeEvent({
    type: "customer.subscription.updated",
    data: { object: subscription("active") },
  } as any);

  assert.deepEqual(retrieveCalls, ["sub-synthetic"]);
  assert.equal(
    writes.find((write) => write.table === "subscriptions")?.value.status,
    "canceled",
  );
  assert.equal(
    writes.find((write) => write.table === "user_entitlements")?.value.plan,
    "free",
  );
});

test("Stripe retrieval failure leaves entitlement state untouched", async () => {
  const writes: Array<{ table: string; action: string; value: any }> = [];
  installDatabase(writes);
  stripe.subscriptions.retrieve = (async () => {
    throw new Error("synthetic Stripe outage");
  }) as typeof stripe.subscriptions.retrieve;

  await assert.rejects(
    processStripeEvent({
      type: "customer.subscription.updated",
      data: { object: subscription("active") },
    } as any),
    /synthetic Stripe outage/,
  );
  assert.deepEqual(writes, []);
});
