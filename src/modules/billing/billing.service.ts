import type Stripe from "stripe";
import { env } from "../../config/env.js";
import { getStripe } from "../../config/stripe.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";

const ACTIVE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
];

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

async function getOrCreateCustomer(userId: string, email: string | null) {
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (lookupError) throw lookupError;
  if (existing) return existing.stripe_customer_id as string;

  const customer = await getStripe().customers.create({
    ...(email ? { email } : {}),
    metadata: { user_id: userId },
  });

  const { error } = await supabaseAdmin.from("billing_customers").upsert(
    {
      user_id: userId,
      stripe_customer_id: customer.id,
      email,
    },
    { onConflict: "user_id" },
  );

  if (error) throw error;
  return customer.id;
}

export async function createCheckoutSession(input: {
  userId: string;
  email: string | null;
  planCode: string;
}) {
  const plan = await getPlan(input.planCode);

  const { data: subscription, error: subscriptionError } = await supabaseAdmin
    .from("subscriptions")
    .select("id")
    .eq("user_id", input.userId)
    .in("status", ACTIVE_SUBSCRIPTION_STATUSES)
    .limit(1)
    .maybeSingle();

  if (subscriptionError) throw subscriptionError;
  if (subscription) {
    throw new AppError(
      409,
      "SUBSCRIPTION_ALREADY_EXISTS",
      "You already have a subscription. Use the billing portal to manage it.",
    );
  }

  const nowIso = new Date().toISOString();
  const { data: openSession, error: openSessionError } = await supabaseAdmin
    .from("billing_checkout_sessions")
    .select("stripe_checkout_session_id, checkout_url, expires_at")
    .eq("user_id", input.userId)
    .eq("billing_plan_id", plan.id)
    .eq("status", "open")
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (openSessionError) throw openSessionError;
  if (openSession?.checkout_url) {
    return {
      checkoutSessionId: openSession.stripe_checkout_session_id,
      checkoutUrl: openSession.checkout_url,
      expiresAt: openSession.expires_at,
    };
  }

  const customerId = await getOrCreateCustomer(input.userId, input.email);
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: input.userId,
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    metadata: {
      user_id: input.userId,
      billing_plan_id: plan.id,
      plan_code: plan.code,
    },
    subscription_data: {
      metadata: {
        user_id: input.userId,
        billing_plan_id: plan.id,
        plan_code: plan.code,
      },
    },
    success_url:
      env.STRIPE_CHECKOUT_SUCCESS_URL ??
      `${env.FRONTEND_URL}/#/account?checkout=success`,
    cancel_url:
      env.STRIPE_CHECKOUT_CANCEL_URL ??
      `${env.FRONTEND_URL}/#/account?checkout=cancelled`,
  });

  const { error } = await supabaseAdmin.from("billing_checkout_sessions").insert({
    user_id: input.userId,
    billing_plan_id: plan.id,
    stripe_checkout_session_id: session.id,
    stripe_customer_id: customerId,
    status: session.status ?? "open",
    checkout_url: session.url,
    expires_at: session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : null,
  });

  if (error) throw error;

  return {
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    expiresAt: session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : null,
  };
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
