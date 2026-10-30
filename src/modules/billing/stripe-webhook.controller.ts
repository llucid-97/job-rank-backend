import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { getStripe } from "../../config/stripe.js";
import { AppError } from "../../middleware/error-handling.js";
import {
  beginWebhookEvent,
  finishWebhookEvent,
  processStripeEvent,
} from "./stripe-webhook.service.js";

export async function handleStripeWebhook(
  request: Request,
  response: Response,
) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return response.status(503).json({ error: { code: "BILLING_UNAVAILABLE", message: "Billing is not configured." } });
  }
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
    event = getStripe().webhooks.constructEvent(
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

  const claimToken = await beginWebhookEvent(event);
  if (!claimToken) return response.status(200).json({ received: true });

  try {
    await processStripeEvent(event);
    await finishWebhookEvent(event.id, claimToken);
    return response.status(200).json({ received: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Webhook processing failed.";
    request.log?.error(
      { eventId: event.id, eventType: event.type },
      "Stripe webhook failed",
    );
    await finishWebhookEvent(event.id, claimToken, message.slice(0, 1000));
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    return response.status(statusCode).json({
      error: {
        code:
          error instanceof AppError
            ? error.code
            : "STRIPE_WEBHOOK_FAILED",
        message:
          error instanceof AppError
            ? error.message
            : "Stripe webhook processing failed.",
      },
    });
  }
}
