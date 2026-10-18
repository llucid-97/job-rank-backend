import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveAccount } from "../../middleware/require-active-account.js";
import {
  deactivateCandidateDocument,
  listCandidateDocuments,
  uploadCandidateDocument,
} from "./candidate.controller.js";
import { candidateDocumentUpload } from "./candidate_upload.middleware.js";
import {
  generateSkillsProfile,
  getActiveSkillsProfile,
  updateSkillsProfile,
} from "./candidate_profile.controller.js";

export const candidateRouter = Router();

candidateRouter.post(
  "/documents",
  authenticate,
  requireActiveAccount,
  candidateDocumentUpload.single("file"),
  uploadCandidateDocument,
);

candidateRouter.post(
  "/profiles/generate",
  authenticate,
  requireActiveAccount,
  generateSkillsProfile,
);

candidateRouter.get(
  "/documents",
  authenticate,
  requireActiveAccount,
  listCandidateDocuments,
);

candidateRouter.put(
  "/profile",
  authenticate,
  requireActiveAccount,
  updateSkillsProfile,
);

candidateRouter.delete(
  "/documents/:id",
  authenticate,
  requireActiveAccount,
  deactivateCandidateDocument,
);

candidateRouter.get(
  "/profile",
  authenticate,
  requireActiveAccount,
  getActiveSkillsProfile,
);
