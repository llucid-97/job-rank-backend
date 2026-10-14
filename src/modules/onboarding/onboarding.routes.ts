import { responseCancellation } from "../../lib/request-cancellation.js";
import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveAccount } from "../../middleware/require-active-account.js";
import { assessJobsSchema, assistSchema, saveSchema } from "./onboarding.schema.js";
import {
  assistOnboarding,
  assessOnboardingJobs,
  getOnboarding,
  saveOnboarding,
} from "./onboarding.service.js";

export const onboardingRouter = Router();
onboardingRouter.use(authenticate, requireActiveAccount);
onboardingRouter.get("/", async (request, response) => {
  response.json({ data: await getOnboarding(request.auth!.userId) });
});
onboardingRouter.put("/", async (request, response) => {
  const { draft, expectedRevision } = saveSchema.parse(request.body);
  response.json({
    data: await saveOnboarding(request.auth!.userId, draft, expectedRevision),
  });
});
onboardingRouter.post("/assess-jobs", async (request, response) => {
  const input = assessJobsSchema.parse(request.body);
  const cancellation = responseCancellation(response);
  try {
    response.json({ data: await assessOnboardingJobs(
      request.auth!.userId,
      input,
      typeof request.id === "number" ? request.id : undefined,
      cancellation.signal,
    ) });
  } finally {
    cancellation.dispose();
  }
});
// One request owns its provider work until completion or browser disconnect.
onboardingRouter.post("/assist", async (request, response) => {
  const input = assistSchema.parse(request.body);
  // A disconnected browser must not leave retries running after the user cancels.
  const cancellation = responseCancellation(response);
  try {
    response.json({
      data: await assistOnboarding(
        request.auth!.userId,
        input,
        typeof request.id === "number" ? request.id : undefined,
        cancellation.signal,
      ),
    });
  } finally {
    cancellation.dispose();
  }
});
