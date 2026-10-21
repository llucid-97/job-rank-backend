import type { Request, Response } from "express";
import { z } from "zod";
import {
  createCheckoutSession,
  createCustomerPortalSession,
  getCurrentSubscription,
  listBillingPlans,
} from "./billing.service.js";

const checkoutSchema = z.object({
  planCode: z.string().trim().min(1).max(100),
});

export async function getPlans(_request: Request, response: Response) {
  return response.status(200).json({ data: await listBillingPlans() });
}

export async function startCheckout(request: Request, response: Response) {
  const { planCode } = checkoutSchema.parse(request.body);
  const data = await createCheckoutSession({
    userId: request.auth!.userId,
    email: request.auth!.email,
    planCode,
  });
  return response.status(201).json({ data });
}

export async function openCustomerPortal(request: Request, response: Response) {
  const data = await createCustomerPortalSession(request.auth!.userId);
  return response.status(201).json({ data });
}

export async function getSubscription(request: Request, response: Response) {
  const data = await getCurrentSubscription(request.auth!.userId);
  return response.status(200).json({ data });
}
