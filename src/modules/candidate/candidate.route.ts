import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveAccount } from "../../middleware/require-active-account.js";
import {
  deactivateCandidateDocument,
  listCandidateDocuments,
  createCandidateDocumentUpload,
  finalizeCandidateDocumentUpload,
  cleanupCandidateDocumentUploads,
} from "./candidate.controller.js";
import { uploadCandidateDocumentWithAdmission } from "./candidate-document-direct-upload.js";
import {
  generateSkillsProfile,
  getActiveSkillsProfile,
} from "./candidate_profile.controller.js";

export const candidateRouter = Router();

candidateRouter.post(
  "/documents/uploads",
  authenticate,
  requireActiveAccount,
  createCandidateDocumentUpload,
);

candidateRouter.post(
  "/documents/uploads/finalize",
  authenticate,
  requireActiveAccount,
  finalizeCandidateDocumentUpload,
);

candidateRouter.get("/documents/staging-cleanup", cleanupCandidateDocumentUploads);

candidateRouter.post(
  "/documents",
  authenticate,
  requireActiveAccount,
  uploadCandidateDocumentWithAdmission,
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
