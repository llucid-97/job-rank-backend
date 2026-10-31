import assert from "node:assert/strict";
import { test } from "node:test";
import type Stripe from "stripe";

test("completion webhook before local checkout persistence stays durable after the late insert", async () => {
  const { supabaseAdmin } = await import("../src/config/supabase.ts");
  const { getStripe } = await import("../src/config/stripe.ts");
  const { createCheckoutSession } = await import("../src/modules/billing/billing.service.ts");
  const { processStripeEvent } = await import("../src/modules/billing/stripe-webhook.service.ts");
  const stripe = getStripe();

  const originalFrom = supabaseAdmin.from;
  const originalRpc = supabaseAdmin.rpc;
  const originalCustomerCreate = stripe.customers.create;
  const originalCheckoutCreate = stripe.checkout.sessions.create;
  let finishInsert!: () => void;
  let markInsertWaiting!: () => void;
  const insertGate = new Promise<void>(resolve => { finishInsert = resolve; });
  const insertWaiting = new Promise<void>(resolve => { markInsertWaiting = resolve; });
  const state: {
    checkoutRow: Record<string, any> | null;
    attempt: Record<string, any> | null;
    localCustomer: Record<string, any> | null;
    checkoutCreates: number;
  } = { checkoutRow: null, attempt: null, localCustomer: null, checkoutCreates: 0 };

  (supabaseAdmin as any).from = (table: string) => {
    const query: any = {
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () => {
        if (table === "billing_plans") {
          return { data: { id: "plan-id", code: "starter", stripe_price_id: "price-id" }, error: null };
        }
        if (table === "billing_customers") return { data: state.localCustomer, error: null };
        throw new Error(`Unexpected maybeSingle table ${table}`);
      },
      upsert: async (row: Record<string, any>, options?: Record<string, any>) => {
        if (table === "billing_customers") {
          state.localCustomer = row;
          return { error: null };
        }
        if (table !== "billing_checkout_sessions") throw new Error(`Unexpected upsert table ${table}`);

        if (options?.ignoreDuplicates) {
          markInsertWaiting();
          await insertGate;
          // Model INSERT ... ON CONFLICT DO NOTHING: the webhook's completed
          // row wins if it was written while this API insert was in flight.
          state.checkoutRow ??= row;
        } else {
          // Webhook upsert is authoritative, including when the row did not
          // exist when checkout.session.completed arrived.
          state.checkoutRow = row;
        }
        return { error: null };
      },
    };
    return query;
  };

  (supabaseAdmin as any).rpc = async (name: string, args: Record<string, any>) => {
    if (name === "record_billing_checkout_completion") {
      if (state.checkoutRow) {
        if (state.checkoutRow.user_id !== args.p_user_id || state.checkoutRow.billing_plan_id !== args.p_billing_plan_id) {
          return { data: null, error: new Error("stored checkout identity conflict") };
        }
        if (state.checkoutRow.status === "open") {
          state.checkoutRow = {
            ...state.checkoutRow,
            status: "complete",
            stripe_customer_id: state.checkoutRow.stripe_customer_id ?? args.p_stripe_customer_id,
            stripe_subscription_id: state.checkoutRow.stripe_subscription_id ?? args.p_stripe_subscription_id,
            completed_at: args.p_completed_at,
          };
        }
        return { data: state.checkoutRow.status === "complete" ? "already_completed" : "ignored_stale", error: null };
      }
      state.checkoutRow = {
        user_id: args.p_user_id,
        billing_plan_id: args.p_billing_plan_id,
        stripe_checkout_session_id: args.p_stripe_checkout_session_id,
        stripe_customer_id: args.p_stripe_customer_id,
        stripe_subscription_id: args.p_stripe_subscription_id,
        checkout_url: args.p_checkout_url,
        expires_at: args.p_expires_at,
        completed_at: args.p_completed_at,
        status: "complete",
      };
      return { data: "inserted", error: null };
    }
    if (name === "claim_billing_checkout_attempt") {
      if (state.checkoutRow?.status === "complete" && state.checkoutRow.stripe_subscription_id) {
        return { data: { status: "subscription_sync_pending" }, error: null };
      }
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
          customer_create_started_at: null,
          stripe_customer_id: null,
          checkout_params: null,
          claim_token: args.p_claim_token,
        };
      }
      state.attempt.claim_token = args.p_claim_token;
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
      return { data: true, error: null };
    }
    if (name === "release_billing_checkout_attempt") return { data: true, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  };

  (stripe.customers as any).create = async () => ({ id: "cus-ordering" });
  (stripe.checkout.sessions as any).create = async () => {
    state.checkoutCreates++;
    return {
      id: "cs-ordering",
      url: "https://checkout.invalid/ordering",
      status: "open",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    } as Stripe.Checkout.Session;
  };

  try {
    const createRequest = createCheckoutSession({ userId: "user-ordering", email: "person@example.test", planCode: "starter" });
    await insertWaiting;

    await processStripeEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs-ordering",
          status: "complete",
          url: null,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          customer: "cus-ordering",
          subscription: "sub-ordering",
          client_reference_id: "user-ordering",
          metadata: { user_id: "user-ordering", billing_plan_id: "plan-id", plan_code: "starter" },
          customer_details: { email: "person@example.test" },
        } as any,
      },
    } as any);

    assert.equal(state.checkoutRow?.status, "complete", "the webhook persists completion before the API insert returns");
    assert.equal(state.checkoutRow?.stripe_subscription_id, "sub-ordering");

    finishInsert();
    await createRequest;
    assert.equal(state.checkoutRow?.status, "complete", "the late API persistence does not downgrade webhook state");
    assert.equal(state.checkoutRow?.stripe_subscription_id, "sub-ordering");

    state.checkoutRow.expires_at = new Date(Date.now() - 60_000).toISOString();
    await assert.rejects(
      () => createCheckoutSession({ userId: "user-ordering", email: "person@example.test", planCode: "starter" }),
      error => (error as any).code === "SUBSCRIPTION_SYNC_PENDING",
    );
    assert.equal(state.checkoutCreates, 1, "expiry does not admit a duplicate while subscription sync is pending");
  } finally {
    finishInsert();
    (supabaseAdmin as any).from = originalFrom;
    (supabaseAdmin as any).rpc = originalRpc;
    (stripe.customers as any).create = originalCustomerCreate;
    (stripe.checkout.sessions as any).create = originalCheckoutCreate;
  }
});
