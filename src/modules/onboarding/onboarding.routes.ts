import { responseCancellation } from "../../lib/request-cancellation.js";
import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveAccount } from "../../middleware/require-active-account.js";
import { assistSchema, saveSchema } from "./onboarding.schema.js";
import { matchLaneJobsSchema, prepareLaneProfilesSchema } from "./lane-profile.schema.js";
import { matchOnboardingJobs } from "./lane-match.service.js";
import { prepareLaneProfiles } from "./lane-profile.service.js";
import {
  assistOnboarding,
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
onboardingRouter.post("/lane-profiles", async (request, response) => {
  const { expectedRevision } = prepareLaneProfilesSchema.parse(request.body);
  const cancellation = responseCancellation(response);
  try {
    response.json({ data: await prepareLaneProfiles(request.auth!.userId, expectedRevision, cancellation.signal) });
  } finally {
    cancellation.dispose();
  }
});
onboardingRouter.post("/match-jobs", async (request, response) => {
  const input = matchLaneJobsSchema.parse(request.body);
  const cancellation = responseCancellation(response);
  try {
    response.json({ data: await matchOnboardingJobs(request.auth!.userId, input, cancellation.signal) });
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
