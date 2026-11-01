import { Router } from "express";
import { cleanupExpiredCodexTestAccounts } from "./codex-test-accounts.controller.js";

export const codexTestAccountsRouter = Router();
codexTestAccountsRouter.get("/cleanup", cleanupExpiredCodexTestAccounts);
