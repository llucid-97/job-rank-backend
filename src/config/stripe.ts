import Stripe from "stripe";

const secretKey = process.env.STRIPE_SECRET_KEY;

if (!secretKey) throw new Error("Missing stripe key");

export const stripe = new Stripe(secretKey);
