import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveAccount } from "../../middleware/require-active-account.js";
import { searchJobs } from "./job.controller.js";
import { getMatchHistory, getMatchHistoryConfiguration, putMatchHistory, deleteMatchHistory } from "./match-history.controller.js";

import { getWorkspace, saveWorkspace } from "./workspace.controller.js";
import { createCoverLetter } from "../cover-letter/cover-letter.controller.js";
import { createFollowUpAnswers } from "../follow-up-answers/follow-up.controller.js";

export const jobRouter = Router();

jobRouter.post("/search", authenticate, requireActiveAccount, searchJobs);

jobRouter.get("/match-history/configuration", authenticate, requireActiveAccount, getMatchHistoryConfiguration);
jobRouter.get("/match-history", authenticate, requireActiveAccount, getMatchHistory);
jobRouter.put("/match-history", authenticate, requireActiveAccount, putMatchHistory);
jobRouter.delete("/match-history", authenticate, requireActiveAccount, deleteMatchHistory);

jobRouter.get("/workspace", authenticate, requireActiveAccount, getWorkspace);
jobRouter.put("/workspace", authenticate, requireActiveAccount, saveWorkspace);

jobRouter.post(
  "/:jobId/cover-letters",
  authenticate,
  requireActiveAccount,
  createCoverLetter,
);

jobRouter.post(
  "/:jobId/follow-up-answers",
  authenticate,
  requireActiveAccount,
  createFollowUpAnswers,
);
