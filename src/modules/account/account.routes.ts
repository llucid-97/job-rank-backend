import { getSearchHistory, saveSearchHistory } from "../jobs/search.controller.js";
import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveAccount } from "../../middleware/require-active-account.js";
import { getEmployerBlocks, putEmployerBlocks } from "./employer-blocks.controller.js";
import { reportSearchRestoreFailure } from "./search-restore-diagnostic.js";
import {
  getMe,
  getPreferences,
  updateMe,
  updatePreferences,
} from "./account.controller.js";

export const accountRouter = Router();

accountRouter.use(authenticate);
accountRouter.use(requireActiveAccount);

accountRouter.get("/me", getMe);
accountRouter.patch("/me", updateMe);

accountRouter.get("/preferences", getPreferences);
accountRouter.patch("/preferences", updatePreferences);
accountRouter.get("/preferences/employer-blocks", getEmployerBlocks);
accountRouter.put("/preferences/employer-blocks", putEmployerBlocks);
accountRouter.post("/client-errors/search-restore", reportSearchRestoreFailure);

accountRouter.get("/search-history", getSearchHistory);
accountRouter.put("/search-history", saveSearchHistory);
