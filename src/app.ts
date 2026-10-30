import type {} from "./types/express.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import { env } from "./config/env.js";
import { pinoHttp } from "pino-http";
import { errorHandler } from "./middleware/error-handling.js";
import { authTestRouter } from "./routes/auth-test.routes.js";
import { accountRouter } from "./modules/account/account.routes.js";
import { candidateRouter } from "./modules/candidate/candidate.route.js";
import { jobRouter } from "./modules/jobs/job.routes.js";
import { rankingRouter } from "./modules/rankings/ranking.routes.js";
import { handleStripeWebhook } from "./modules/billing/stripe-webhook.controller.js";
import { billingRouter } from "./modules/billing/billing.route.js";
import { providerRouter } from "./modules/provider-proxy/provider.routes.js";

export const app = express();

app.disable("x-powered-by");

app.use(helmet());

app.use(
  cors({
    origin: env.FRONTEND_URL,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(
  pinoHttp({
    autoLogging: false,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "headers.authorization",
      "headers.cookie",
    ],
  }),
);

app.use("/v1/jobs/workspace", express.json({ limit: "3mb" }));
app.post(
  "/v1/billing/webhooks/stripe",
  express.raw({ type: "application/json" }),
  handleStripeWebhook,
);
app.use(express.json({ limit: "1mb" }));

app.get("/", (_request, response) => {
  response.status(200).json({
    name: "Job Rank API",
    message: "Welcome to the Job Rank backend.",
    healthCheck: "/health",
  });
});

app.get("/health", (_request, response) => {
  response.status(200).json({
    status: "ok",
    message: "Job Rank API is running",
    environment: env.NODE_ENV,
  });
});

app.use("/v1", providerRouter);
app.use("/v1/auth-test", authTestRouter);
app.use("/v1/candidate", candidateRouter);
app.use("/v1/jobs", jobRouter);
app.use("/v1/ranking-runs", rankingRouter);
app.use("/v1/billing", (_request, response, next) => {
  if (!env.STRIPE_SECRET_KEY) return response.status(503).json({ error: { code: "BILLING_UNAVAILABLE", message: "Billing is not configured." } });
  next();
}, billingRouter);
app.use("/v1", accountRouter);
app.use((request, response) => {
  response.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `The route ${request.method} ${request.path} does not exist.`,
    },
  });
});

app.use(errorHandler);

export default app;
