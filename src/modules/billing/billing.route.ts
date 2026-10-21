import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveAccount } from "../../middleware/require-active-account.js";
import {
  getPlans,
  getSubscription,
  openCustomerPortal,
  startCheckout,
} from "./billing.controller.js";

export const billingRouter = Router();

billingRouter.get("/plans", getPlans);
billingRouter.get("/subscription", authenticate, getSubscription);
billingRouter.post(
  "/checkout-session",
  authenticate,
  requireActiveAccount,
  startCheckout,
);
billingRouter.post("/customer-portal", authenticate, openCustomerPortal);
