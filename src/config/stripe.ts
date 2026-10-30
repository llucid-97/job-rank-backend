import Stripe from "stripe";
import { env } from "./env.js";
import { AppError } from "../middleware/error-handling.js";

const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : undefined;

export function getStripe(): Stripe {
  if (!stripe) throw new AppError(503, "BILLING_UNAVAILABLE", "Billing is not configured.");
  return stripe;
}
