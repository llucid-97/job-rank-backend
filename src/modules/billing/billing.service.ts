import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { getStripe } from "../../config/stripe.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";

const AI_SPEND_LIMIT_DISCLOSURE = {
  aiSpendLimitEnforced: false,
  aiSpendLimitNotice: "Target only; not an enforced hard spending cap.",
};

function discloseAiSpendLimit<T extends Record<string, unknown>>(plan: T): T {
  return { ...plan, ...AI_SPEND_LIMIT_DISCLOSURE };
}

export async function listBillingPlans() {
  const { data, error } = await supabaseAdmin
    .from("billing_plans")
    .select(
      "id, code, name, description, billing_interval, currency, unit_amount, monthly_request_limit, ai_cost_limit_usd",
    )
    .eq("enabled", true)
    .order("unit_amount", { ascending: true });

  if (error) throw error;
  return (data ?? []).map(discloseAiSpendLimit);
}

async function getPlan(planCode: string) {
  const { data, error } = await supabaseAdmin
    .from("billing_plans")
    .select("*")
    .eq("code", planCode)
    .eq("enabled", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new AppError(404, "BILLING_PLAN_NOT_FOUND", "The selected billing plan was not found.");
  }

  return data;
}

export async function createCheckoutSession(input: {
  userId: string;
  email: string | null;
  planCode: string;
}) {
  const plan = await getPlan(input.planCode);

  const claimToken = randomUUID();
  const { data: claimResult, error: claimError } = await supabaseAdmin.rpc(
    "claim_billing_checkout_attempt",
    {
      p_user_id: input.userId,
      p_attempt_id: randomUUID(),
      p_claim_token: claimToken,
      p_billing_plan_id: plan.id,
      p_plan_code: plan.code,
      p_stripe_price_id: plan.stripe_price_id,
      p_email: input.email,
      p_success_url: env.STRIPE_CHECKOUT_SUCCESS_URL ?? `${env.FRONTEND_URL}/#/account?checkout=success`,
      p_cancel_url: env.STRIPE_CHECKOUT_CANCEL_URL ?? `${env.FRONTEND_URL}/#/account?checkout=cancelled`,
    },
  );
  if (claimError) throw claimError;

  const claim = claimResult as {
    status: string;
    session?: { stripe_checkout_session_id: string; checkout_url: string | null; expires_at: string | null };
    attempt?: {
      user_id: string;
      attempt_id: string;
      customer_create_attempt_id: string;
      billing_plan_id: string;
      plan_code: string;
      stripe_price_id: string;
      email_snapshot: string | null;
      success_url: string;
      cancel_url: string;
      customer_create_started_at: string | null;
      stripe_customer_id: string | null;
      checkout_params: Stripe.Checkout.SessionCreateParams | null;
      claim_token: string;
    };
  };

  if (claim?.status === "subscription_exists") {
    throw new AppError(409, "SUBSCRIPTION_ALREADY_EXISTS", "You already have a subscription. Use the billing portal to manage it.");
  }
  if (claim?.status === "existing_session") {
    if (!claim.session?.checkout_url) {
      throw new AppError(503, "CHECKOUT_SESSION_UNAVAILABLE", "The existing checkout session is temporarily unavailable.");
    }
    return {
      checkoutSessionId: claim.session.stripe_checkout_session_id,
      checkoutUrl: claim.session.checkout_url,
      expiresAt: claim.session.expires_at,
    };
  }
  if (claim?.status === "other_plan_open" || claim?.status === "other_plan_in_progress") {
    throw new AppError(409, "CHECKOUT_ALREADY_IN_PROGRESS", "Finish or let the existing checkout expire before choosing another plan.");
  }
  if (claim?.status === "busy") {
    throw new AppError(409, "CHECKOUT_IN_PROGRESS", "A checkout is already being created. Retry shortly.");
  }
  if (claim?.status !== "claimed" || !claim.attempt) {
    throw new Error("Billing checkout claim returned an invalid result.");
  }

  const attempt = claim.attempt;
  const attemptId = attempt.attempt_id;
  const stripe = getStripe();
  try {
    let customerId = attempt.stripe_customer_id;
    let params = attempt.checkout_params;

    if (!params) {
      if (!customerId) {
        const { data: existingCustomer, error: customerLookupError } = await supabaseAdmin
          .from("billing_customers")
          .select("stripe_customer_id")
          .eq("user_id", input.userId)
          .maybeSingle();
        if (customerLookupError) throw customerLookupError;
        customerId = existingCustomer?.stripe_customer_id ?? null;

        if (!customerId) {
          let customer: Stripe.Customer;
          const customerCreateStartedAt = attempt.customer_create_started_at
            ? new Date(attempt.customer_create_started_at).getTime()
            : null;
          if (customerCreateStartedAt !== null && Date.now() - customerCreateStartedAt >= 23 * 60 * 60 * 1000) {
            // Stripe search is eventually consistent. On a miss, fail closed:
            // the customer may exist even if it is not searchable yet.
            const recovered = await stripe.customers.search({
              query: `metadata['jobrank_customer_attempt_id']:'${attempt.customer_create_attempt_id}'`,
              limit: 2,
            });
            if (recovered.data.length !== 1) {
              throw new AppError(503, "BILLING_CUSTOMER_RECOVERY_REQUIRED", "Billing setup is being reconciled. Retry later.");
            }
            customer = recovered.data[0]!;
          } else {
            const { data: startedAt, error: startError } = await supabaseAdmin.rpc(
              "mark_billing_checkout_customer_creation_started",
              { p_user_id: input.userId, p_attempt_id: attemptId, p_claim_token: claimToken },
            );
            if (startError || typeof startedAt !== "string") throw startError ?? new Error("Could not persist customer creation attempt.");
            customer = await stripe.customers.create(
              {
                ...(attempt.email_snapshot ? { email: attempt.email_snapshot } : {}),
                metadata: {
                  user_id: input.userId,
                  jobrank_customer_attempt_id: attempt.customer_create_attempt_id,
                },
              },
              { idempotencyKey: `jobrank-customer-${attempt.customer_create_attempt_id}` },
            );
          }

          const { error: customerSaveError } = await supabaseAdmin.from("billing_customers").upsert(
            { user_id: input.userId, stripe_customer_id: customer.id, email: attempt.email_snapshot },
            { onConflict: "user_id" },
          );
          if (customerSaveError) throw customerSaveError;
          customerId = customer.id;
        }
      }

      const proposedParams: Stripe.Checkout.SessionCreateParams = {
        mode: "subscription",
        customer: customerId,
        client_reference_id: input.userId,
        line_items: [{ price: attempt.stripe_price_id, quantity: 1 }],
        metadata: {
          user_id: input.userId,
          billing_plan_id: attempt.billing_plan_id,
          plan_code: attempt.plan_code,
        },
        subscription_data: {
          metadata: {
            user_id: input.userId,
            billing_plan_id: attempt.billing_plan_id,
            plan_code: attempt.plan_code,
          },
        },
        success_url: attempt.success_url,
        cancel_url: attempt.cancel_url,
      };
      const { data: stored, error: paramsError } = await supabaseAdmin.rpc(
        "save_billing_checkout_params",
        {
          p_user_id: input.userId,
          p_attempt_id: attemptId,
          p_claim_token: claimToken,
          p_stripe_customer_id: customerId,
          p_checkout_params: proposedParams,
        },
      );
      if (paramsError || !stored?.params || typeof stored.customer_id !== "string") {
        throw paramsError ?? new Error("Could not freeze checkout parameters.");
      }
      customerId = stored.customer_id;
      params = stored.params as Stripe.Checkout.SessionCreateParams;
    }

    const { error: startedError } = await supabaseAdmin.rpc(
      "mark_billing_checkout_creation_started",
      { p_user_id: input.userId, p_attempt_id: attemptId, p_claim_token: claimToken },
    );
    if (startedError) throw startedError;

    const session = await stripe.checkout.sessions.create(params, {
      idempotencyKey: `jobrank-checkout-${attemptId}`,
    });

    const { error: sessionSaveError } = await supabaseAdmin.from("billing_checkout_sessions").insert({
      user_id: input.userId,
      billing_plan_id: attempt.billing_plan_id,
      stripe_checkout_session_id: session.id,
      stripe_customer_id: customerId ?? attempt.stripe_customer_id,
      status: session.status ?? "open",
      checkout_url: session.url,
      expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
    });
    if (sessionSaveError) throw sessionSaveError;

    // A lost finish response is safe: the persisted open session is checked
    // before another attempt can be admitted.
    const { error: finishError } = await supabaseAdmin.rpc(
      "finish_billing_checkout_attempt",
      { p_user_id: input.userId, p_attempt_id: attemptId, p_claim_token: claimToken },
    );
    if (finishError) console.error("Could not retire completed billing checkout attempt", { attemptId });

    return {
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
    };
  } catch (error) {
    await Promise.resolve(supabaseAdmin.rpc(
      "release_billing_checkout_attempt",
      { p_user_id: input.userId, p_attempt_id: attemptId, p_claim_token: claimToken },
    )).catch(() => undefined);
    throw error;
  }
}

export async function createCustomerPortalSession(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new AppError(
      404,
      "BILLING_CUSTOMER_NOT_FOUND",
      "No billing account was found for this user.",
    );
  }

  const session = await getStripe().billingPortal.sessions.create({
    customer: data.stripe_customer_id,
    return_url: env.STRIPE_PORTAL_RETURN_URL ?? `${env.FRONTEND_URL}/#/account`,
  });

  return { portalUrl: session.url };
}

export async function getCurrentSubscription(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select(
      `
      id,
      status,
      cancel_at_period_end,
      current_period_start,
      current_period_end,
      trial_start,
      trial_end,
      billing_plans (
        code,
        name,
        billing_interval,
        currency,
        unit_amount,
        monthly_request_limit,
        ai_cost_limit_usd
      )
    `,
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return data;

  const plans = data.billing_plans;
  return {
    ...data,
    billing_plans: Array.isArray(plans)
      ? plans.map(discloseAiSpendLimit)
      : plans
        ? discloseAiSpendLimit(plans)
        : plans,
  };
}

export function stripeId(value: string | Stripe.Customer | Stripe.Subscription | null) {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}
