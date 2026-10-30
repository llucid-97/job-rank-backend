import type Stripe from "stripe";
import { getStripe } from "../../config/stripe.js";
import { supabaseAdmin } from "../../config/supabase.js";

const FREE_ENTITLEMENT = {
  plan: "free",
  monthly_request_limit: 20,
  ai_cost_limit_usd: 1,
};

function isoFromUnix(value: number | null | undefined) {
  return value ? new Date(value * 1000).toISOString() : null;
}

function objectId(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

async function resolveUserId(customerId: string, metadataUserId?: string) {
  if (metadataUserId) return metadataUserId;

  const { data, error } = await supabaseAdmin
    .from("billing_customers")
    .select("user_id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error(`No user is linked to Stripe customer ${customerId}.`);
  return data.user_id as string;
}

async function synchronizeCustomer(session: Stripe.Checkout.Session) {
  const customerId = objectId(session.customer);
  const userId = session.metadata?.user_id ?? session.client_reference_id;
  if (!customerId || !userId) return;

  const email = session.customer_details?.email ?? session.customer_email ?? null;
  const { error } = await supabaseAdmin.from("billing_customers").upsert(
    {
      user_id: userId,
      stripe_customer_id: customerId,
      email,
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
}

async function completeCheckoutSession(session: Stripe.Checkout.Session) {
  await synchronizeCustomer(session);

  const { error } = await supabaseAdmin
    .from("billing_checkout_sessions")
    .update({
      status: session.status ?? "complete",
      stripe_customer_id: objectId(session.customer),
      stripe_subscription_id: objectId(session.subscription),
      completed_at: new Date().toISOString(),
    })
    .eq("stripe_checkout_session_id", session.id);

  if (error) throw error;
}

function subscriptionPeriod(subscription: Stripe.Subscription) {
  const item = subscription.items.data[0];
  return {
    start: item ? isoFromUnix(item.current_period_start) : null,
    end: item ? isoFromUnix(item.current_period_end) : null,
  };
}

export async function synchronizeSubscription(subscription: Stripe.Subscription) {
  const customerId = objectId(subscription.customer);
  const item = subscription.items.data[0];
  const priceId = item?.price.id;
  if (!customerId || !priceId) {
    throw new Error(`Stripe subscription ${subscription.id} is missing its customer or price.`);
  }

  const userId = await resolveUserId(customerId, subscription.metadata.user_id);
  const { data: plan, error: planError } = await supabaseAdmin
    .from("billing_plans")
    .select("id, code, monthly_request_limit, ai_cost_limit_usd")
    .eq("stripe_price_id", priceId)
    .maybeSingle();

  if (planError) throw planError;
  if (!plan) throw new Error(`No billing plan matches Stripe price ${priceId}.`);

  const period = subscriptionPeriod(subscription);
  const { error: subscriptionError } = await supabaseAdmin
    .from("subscriptions")
    .upsert(
      {
        user_id: userId,
        billing_plan_id: plan.id,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscription.id,
        stripe_price_id: priceId,
        status: subscription.status,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_start: period.start,
        current_period_end: period.end,
        trial_start: isoFromUnix(subscription.trial_start),
        trial_end: isoFromUnix(subscription.trial_end),
        canceled_at: isoFromUnix(subscription.canceled_at),
        ended_at: isoFromUnix(subscription.ended_at),
      },
      { onConflict: "stripe_subscription_id" },
    );

  if (subscriptionError) throw subscriptionError;

  const retainsPaidAccess = ["active", "trialing", "past_due"].includes(
    subscription.status,
  );
  const entitlement = retainsPaidAccess
    ? {
        plan: plan.code,
        monthly_request_limit: plan.monthly_request_limit ?? 20,
        ai_cost_limit_usd: plan.ai_cost_limit_usd ?? 1,
        period_started_at: period.start ?? new Date().toISOString(),
        period_ends_at: period.end ?? new Date().toISOString(),
      }
    : {
        ...FREE_ENTITLEMENT,
        period_started_at: new Date().toISOString(),
        period_ends_at: new Date(
          new Date().setUTCMonth(new Date().getUTCMonth() + 1),
        ).toISOString(),
      };

  const { error: entitlementError } = await supabaseAdmin
    .from("user_entitlements")
    .update(entitlement)
    .eq("user_id", userId);

  if (entitlementError) throw entitlementError;
}

async function synchronizeInvoice(invoice: Stripe.Invoice) {
  const customerId = objectId(invoice.customer);
  if (!customerId) throw new Error(`Stripe invoice ${invoice.id} has no customer.`);

  const invoiceRecord = invoice as unknown as {
    subscription?: unknown;
    parent?: { subscription_details?: { subscription?: unknown } } | null;
  };
  const stripeSubscriptionId =
    objectId(invoiceRecord.subscription) ??
    objectId(invoiceRecord.parent?.subscription_details?.subscription);
  const userId = await resolveUserId(customerId);

  let localSubscriptionId: string | null = null;
  if (stripeSubscriptionId) {
    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .select("id")
      .eq("stripe_subscription_id", stripeSubscriptionId)
      .maybeSingle();
    if (error) throw error;
    localSubscriptionId = data?.id ?? null;
  }

  const { error } = await supabaseAdmin.from("billing_invoices").upsert(
    {
      user_id: userId,
      subscription_id: localSubscriptionId,
      stripe_invoice_id: invoice.id,
      stripe_subscription_id: stripeSubscriptionId,
      stripe_customer_id: customerId,
      status: invoice.status ?? "unknown",
      currency: invoice.currency,
      amount_due: invoice.amount_due,
      amount_paid: invoice.amount_paid,
      hosted_invoice_url: invoice.hosted_invoice_url,
      period_start: isoFromUnix(invoice.period_start),
      period_end: isoFromUnix(invoice.period_end),
      paid_at: isoFromUnix(invoice.status_transitions.paid_at),
    },
    { onConflict: "stripe_invoice_id" },
  );
  if (error) throw error;

  if (invoice.status === "paid" && stripeSubscriptionId) {
    const currentSubscription = await getStripe().subscriptions.retrieve(
      stripeSubscriptionId,
    );
    await synchronizeSubscription(currentSubscription);
  }
}

export async function processStripeEvent(event: Stripe.Event) {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      await completeCheckoutSession(event.data.object);
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      // Stripe does not guarantee delivery order; sync its current resource, not this event snapshot.
      const eventSubscription = event.data.object as Stripe.Subscription;
      const currentSubscription = await getStripe().subscriptions.retrieve(
        eventSubscription.id,
      );
      await synchronizeSubscription(currentSubscription);
      break;
    }
    case "invoice.paid":
    case "invoice.payment_failed":
      await synchronizeInvoice(event.data.object);
      break;
    default:
      break;
  }
}

export async function beginWebhookEvent(event: Stripe.Event) {
  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("stripe_webhook_events")
    .select("processing_status, processing_attempts")
    .eq("stripe_event_id", event.id)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing?.processing_status === "processed") return false;

  if (existing) {
    const { error } = await supabaseAdmin
      .from("stripe_webhook_events")
      .update({
        processing_status: "processing",
        processing_attempts: existing.processing_attempts + 1,
        last_error: null,
      })
      .eq("stripe_event_id", event.id);
    if (error) throw error;
    return true;
  }

  const { error } = await supabaseAdmin.from("stripe_webhook_events").insert({
    stripe_event_id: event.id,
    event_type: event.type,
    livemode: event.livemode,
    stripe_api_version: event.api_version,
    processing_status: "processing",
    processing_attempts: 1,
    payload: event,
  });

  if (error?.code === "23505") return false;
  if (error) throw error;
  return true;
}

export async function finishWebhookEvent(
  eventId: string,
  errorMessage?: string,
) {
  const { error } = await supabaseAdmin
    .from("stripe_webhook_events")
    .update(
      errorMessage
        ? { processing_status: "failed", last_error: errorMessage }
        : {
            processing_status: "processed",
            processed_at: new Date().toISOString(),
            last_error: null,
          },
    )
    .eq("stripe_event_id", eventId);
  if (error) throw error;
}
