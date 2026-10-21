import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { stripe } from "../../config/stripe.js";
import {
  beginWebhookEvent,
  finishWebhookEvent,
  processStripeEvent,
} from "./stripe-webhook.service.js";

export async function handleStripeWebhook(
  request: Request,
  response: Response,
) {
  const signature = request.headers["stripe-signature"];
  if (typeof signature !== "string") {
    return response.status(400).json({
      error: {
        code: "MISSING_STRIPE_SIGNATURE",
        message: "Stripe signature is missing.",
      },
    });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      request.body,
      signature,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return response.status(400).json({
      error: {
        code: "INVALID_STRIPE_SIGNATURE",
        message: "Stripe signature is invalid.",
      },
    });
  }

  const shouldProcess = await beginWebhookEvent(event);
  if (!shouldProcess) return response.status(200).json({ received: true });

  try {
    await processStripeEvent(event);
    await finishWebhookEvent(event.id);
    return response.status(200).json({ received: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Webhook processing failed.";
    request.log?.error(
      { eventId: event.id, eventType: event.type },
      "Stripe webhook failed",
    );
    await finishWebhookEvent(event.id, message.slice(0, 1000));
    return response.status(500).json({
      error: {
        code: "STRIPE_WEBHOOK_FAILED",
        message: "Stripe webhook processing failed.",
      },
    });
  }
}
