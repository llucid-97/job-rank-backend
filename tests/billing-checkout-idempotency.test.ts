import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";

type TestOptions = {
  ambiguousFirstCustomerCreate?: boolean;
  ambiguousFirstCheckoutCreate?: boolean;
  failFirstCustomerSave?: boolean;
  failFirstSessionInsert?: boolean;
  ambiguousFirstSessionInsert?: boolean;
  existingSession?: Record<string, unknown>;
  searchResults?: Stripe.Customer[];
  customerCreateStartedAt?: string | null;
};

async function withCheckoutMocks(options: TestOptions, run: (state: any) => Promise<void>) {
  const { supabaseAdmin } = await import("../src/config/supabase.ts");
  const { getStripe } = await import("../src/config/stripe.ts");
  const { createCheckoutSession } = await import("../src/modules/billing/billing.service.ts");
  const stripe = getStripe();

  const originalFrom = supabaseAdmin.from;
  const originalRpc = supabaseAdmin.rpc;
  const originalCustomerCreate = stripe.customers.create;
  const originalCustomerSearch = stripe.customers.search;
  const originalCheckoutCreate = stripe.checkout.sessions.create;
  const state: any = {
    createCheckoutSession,
    customerCreates: 0,
    checkoutCreates: 0,
    customerRequests: [] as any[],
    checkoutRequests: [] as any[],
    customerByKey: new Map<string, any>(),
    checkoutByKey: new Map<string, any>(),
    localCustomer: null as any,
    attempt: null as any,
    activeClaim: false,
    openSession: options.existingSession ?? null,
    sessionInsertCount: 0,
    customerSaveCount: 0,
    options,
  };

  (supabaseAdmin as any).from = (table: string) => {
    const builder: any = {
      select() { return this; },
      eq() { return this; },
      in() { return this; },
      gt() { return this; },
      order() { return this; },
      limit() { return this; },
      maybeSingle: async () => {
        if (table === "billing_plans") {
          return { data: { id: "plan-id", code: "starter", stripe_price_id: "price-id" }, error: null };
        }
        if (table === "billing_customers") return { data: state.localCustomer, error: null };
        throw new Error(`Unexpected maybeSingle table ${table}`);
      },
      upsert: async (row: any) => {
        state.customerSaveCount++;
        if (options.failFirstCustomerSave && state.customerSaveCount === 1) {
          return { error: { code: "08006", message: "synthetic ambiguous customer save" } };
        }
        state.localCustomer = row;
        return { error: null };
      },
      insert: async (row: any) => {
        state.sessionInsertCount++;
        if (options.ambiguousFirstSessionInsert && state.sessionInsertCount === 1) {
          state.openSession = {
            stripe_checkout_session_id: row.stripe_checkout_session_id,
            checkout_url: row.checkout_url,
            expires_at: row.expires_at,
            billing_plan_id: row.billing_plan_id,
          };
          return { error: { code: "08006", message: "synthetic lost insert response" } };
        }
        if (options.failFirstSessionInsert && state.sessionInsertCount === 1) {
          return { error: { code: "08006", message: "synthetic uncommitted insert failure" } };
        }
        state.openSession = {
          stripe_checkout_session_id: row.stripe_checkout_session_id,
          checkout_url: row.checkout_url,
          expires_at: row.expires_at,
          billing_plan_id: row.billing_plan_id,
        };
        return { error: null };
      },
    };
    return builder;
  };

  (supabaseAdmin as any).rpc = async (name: string, args: any) => {
    if (name === "claim_billing_checkout_attempt") {
      if (state.openSession) {
        if (state.openSession.billing_plan_id === args.p_billing_plan_id) {
          return { data: { status: "existing_session", session: state.openSession }, error: null };
        }
        return { data: { status: "other_plan_open", session: state.openSession }, error: null };
      }
      if (state.activeClaim) return { data: { status: "busy" }, error: null };
      if (!state.attempt) {
        state.attempt = {
          user_id: args.p_user_id,
          attempt_id: args.p_attempt_id,
          customer_create_attempt_id: args.p_attempt_id,
          billing_plan_id: args.p_billing_plan_id,
          plan_code: args.p_plan_code,
          stripe_price_id: args.p_stripe_price_id,
          email_snapshot: args.p_email,
          success_url: args.p_success_url,
          cancel_url: args.p_cancel_url,
          customer_create_started_at: options.customerCreateStartedAt ?? null,
          stripe_customer_id: null,
          checkout_params: null,
          claim_token: args.p_claim_token,
        };
      } else {
        state.attempt.claim_token = args.p_claim_token;
      }
      state.activeClaim = true;
      return { data: { status: "claimed", attempt: structuredClone(state.attempt) }, error: null };
    }
    if (name === "mark_billing_checkout_customer_creation_started") {
      state.attempt.customer_create_started_at ??= new Date().toISOString();
      return { data: state.attempt.customer_create_started_at, error: null };
    }
    if (name === "save_billing_checkout_params") {
      state.attempt.stripe_customer_id ??= args.p_stripe_customer_id;
      state.attempt.checkout_params ??= args.p_checkout_params;
      return { data: { customer_id: state.attempt.stripe_customer_id, params: state.attempt.checkout_params }, error: null };
    }
    if (name === "mark_billing_checkout_creation_started") return { data: new Date(Date.now() + 24 * 3600_000).toISOString(), error: null };
    if (name === "finish_billing_checkout_attempt") {
      state.attempt = null;
      state.activeClaim = false;
      return { data: true, error: null };
    }
    if (name === "release_billing_checkout_attempt") {
      state.activeClaim = false;
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  };

  (stripe.customers as any).create = async (params: any, requestOptions: any) => {
    state.customerRequests.push({ params: structuredClone(params), options: structuredClone(requestOptions) });
    const key = requestOptions?.idempotencyKey;
    if (state.customerByKey.has(key)) return state.customerByKey.get(key);
    const customer = { id: `cus-${++state.customerCreates}`, ...params };
    state.customerByKey.set(key, customer);
    if (options.ambiguousFirstCustomerCreate && state.customerRequests.length === 1) {
      throw new Error("synthetic lost Stripe customer response");
    }
    return customer;
  };
  (stripe.customers as any).search = async () => ({ data: options.searchResults ?? [] });
  (stripe.checkout.sessions as any).create = async (params: any, requestOptions: any) => {
    state.checkoutRequests.push({ params: structuredClone(params), options: structuredClone(requestOptions) });
    const key = requestOptions?.idempotencyKey;
    if (state.checkoutByKey.has(key)) return state.checkoutByKey.get(key);
    const session = {
      id: `cs-${++state.checkoutCreates}`,
      url: `https://checkout.invalid/${state.checkoutCreates}`,
      status: "open",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    };
    state.checkoutByKey.set(key, session);
    if (options.ambiguousFirstCheckoutCreate && state.checkoutRequests.length === 1) {
      throw new Error("synthetic lost Stripe checkout response");
    }
    return session;
  };

  try {
    await run(state);
  } finally {
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).rpc = originalRpc;
    (stripe.customers as any).create = originalCustomerCreate;
    (stripe.customers as any).search = originalCustomerSearch;
    (stripe.checkout.sessions as any).create = originalCheckoutCreate;
  }
}

test("parallel same-user requests admit one Stripe checkout and block another plan", async () => {
  await withCheckoutMocks({}, async state => {
    let enteredCustomerCreate!: () => void;
    let releaseCustomerCreate!: () => void;
    const entered = new Promise<void>(resolve => { enteredCustomerCreate = resolve; });
    const customerGate = new Promise<void>(resolve => { releaseCustomerCreate = resolve; });
    const { getStripe } = await import("../src/config/stripe.ts");
    const stripe = getStripe();
    const realCreate = (stripe.customers as any).create;
    (stripe.customers as any).create = async (...args: any[]) => {
      enteredCustomerCreate();
      await customerGate;
      return realCreate(...args);
    };

    const first = state.createCheckoutSession({ userId: "user-a", email: "a@example.test", planCode: "starter" });
    await entered;
    await assert.rejects(
      () => state.createCheckoutSession({ userId: "user-a", email: "a@example.test", planCode: "starter" }),
      error => (error as any).code === "CHECKOUT_IN_PROGRESS",
    );
    releaseCustomerCreate();
    await first;
    assert.equal(state.checkoutCreates, 1);
    assert.equal(state.customerCreates, 1);
    assert.equal(state.checkoutRequests.length, 1);
    assert.match(state.checkoutRequests[0].options.idempotencyKey, /^jobrank-checkout-/);
    assert.match(state.customerRequests[0].options.idempotencyKey, /^jobrank-customer-/);
  });
});

test("session-create crash retry reuses the same key and frozen parameters", async () => {
  await withCheckoutMocks({ failFirstSessionInsert: true }, async state => {
    const input = { userId: "user-a", email: "a@example.test", planCode: "starter" };
    await assert.rejects(() => state.createCheckoutSession(input));
    assert.equal(state.checkoutCreates, 1, "first remote session was created before local insert failed");
    const result = await state.createCheckoutSession(input);
    assert.equal(result.checkoutSessionId, "cs-1");
    assert.equal(state.checkoutCreates, 1, "same Stripe idempotency key replays the original session");
    assert.equal(state.checkoutRequests[0].options.idempotencyKey, state.checkoutRequests[1].options.idempotencyKey);
    assert.deepEqual(state.checkoutRequests[0].params, state.checkoutRequests[1].params);
    assert.equal(state.customerCreates, 1);
  });
});

test("ambiguous Stripe session-create response retries the same remote operation", async () => {
  await withCheckoutMocks({ ambiguousFirstCheckoutCreate: true }, async state => {
    const input = { userId: "user-a", email: "a@example.test", planCode: "starter" };
    await assert.rejects(() => state.createCheckoutSession(input));
    const result = await state.createCheckoutSession(input);
    assert.equal(result.checkoutSessionId, "cs-1");
    assert.equal(state.checkoutCreates, 1);
    assert.equal(state.checkoutRequests[0].options.idempotencyKey, state.checkoutRequests[1].options.idempotencyKey);
    assert.deepEqual(state.checkoutRequests[0].params, state.checkoutRequests[1].params);
  });
});

test("ambiguous Stripe customer-create response retries the same remote operation", async () => {
  await withCheckoutMocks({ ambiguousFirstCustomerCreate: true }, async state => {
    const input = { userId: "user-a", email: "a@example.test", planCode: "starter" };
    await assert.rejects(() => state.createCheckoutSession(input));
    const result = await state.createCheckoutSession(input);
    assert.equal(result.checkoutSessionId, "cs-1");
    assert.equal(state.customerCreates, 1);
    assert.equal(state.customerRequests[0].options.idempotencyKey, state.customerRequests[1].options.idempotencyKey);
    assert.deepEqual(state.customerRequests[0].params, state.customerRequests[1].params);
  });
});

test("ambiguous session-row write retries by reusing the stored open session", async () => {
  await withCheckoutMocks({ ambiguousFirstSessionInsert: true }, async state => {
    const input = { userId: "user-a", email: "a@example.test", planCode: "starter" };
    await assert.rejects(() => state.createCheckoutSession(input));
    const result = await state.createCheckoutSession({ ...input, email: "changed@example.test" });
    assert.equal(result.checkoutSessionId, "cs-1");
    assert.equal(state.checkoutCreates, 1);
    assert.equal(state.checkoutRequests.length, 1);
  });
});

test("ambiguous customer-row write retries with the original customer idempotency key", async () => {
  await withCheckoutMocks({ failFirstCustomerSave: true }, async state => {
    const input = { userId: "user-a", email: "a@example.test", planCode: "starter" };
    await assert.rejects(() => state.createCheckoutSession(input));
    const result = await state.createCheckoutSession({ ...input, email: "changed@example.test" });
    assert.equal(result.checkoutSessionId, "cs-1");
    assert.equal(state.customerCreates, 1);
    assert.equal(state.customerRequests.length, 2);
    assert.equal(state.customerRequests[0].options.idempotencyKey, state.customerRequests[1].options.idempotencyKey);
    assert.deepEqual(state.customerRequests[0].params, state.customerRequests[1].params);
  });
});

test("existing same-plan session is reused and another plan is rejected", async () => {
  const existing = {
    stripe_checkout_session_id: "cs-existing",
    checkout_url: "https://checkout.invalid/existing",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    billing_plan_id: "plan-id",
  };
  await withCheckoutMocks({ existingSession: existing }, async state => {
    const result = await state.createCheckoutSession({ userId: "user-a", email: "a@example.test", planCode: "starter" });
    assert.equal(result.checkoutSessionId, "cs-existing");
    assert.equal(state.checkoutCreates, 0);
    assert.equal(state.customerCreates, 0);
  });
});

test("old ambiguous customer creation searches by its stable metadata and fails closed on a miss", async () => {
  const old = new Date(Date.now() - 24 * 3600_000).toISOString();
  await withCheckoutMocks({ customerCreateStartedAt: old, searchResults: [{ id: "cus-recovered" } as Stripe.Customer] }, async state => {
    const result = await state.createCheckoutSession({ userId: "user-a", email: "changed@example.test", planCode: "starter" });
    assert.equal(result.checkoutSessionId, "cs-1");
    assert.equal(state.customerCreates, 0);
    assert.equal(state.checkoutRequests[0].params.customer, "cus-recovered");
  });

  await withCheckoutMocks({ customerCreateStartedAt: old }, async state => {
    await assert.rejects(
      () => state.createCheckoutSession({ userId: "user-a", email: "a@example.test", planCode: "starter" }),
      error => (error as any).code === "BILLING_CUSTOMER_RECOVERY_REQUIRED",
    );
    assert.equal(state.customerCreates, 0);
    assert.equal(state.checkoutCreates, 0);
  });
});
