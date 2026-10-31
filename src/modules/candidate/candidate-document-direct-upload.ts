import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";
import { uploadCandidateDocument } from "./candidate.controller.js";
import { candidateDocumentUpload } from "./candidate_upload.middleware.js";

type AsyncHandler = (request: Request, response: Response) => Promise<unknown>;
type MultipartParser = (request: Request, response: Response) => Promise<void>;
type AcquireLease = (userId: string, requestId: string) => Promise<number>;
type ReleaseLease = (userId: string, requestId: string) => Promise<boolean>;

export async function acquireCandidateDocumentDirectUpload(
  userId: string,
  requestId: string,
): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc(
    "acquire_candidate_document_direct_upload",
    { p_user_id: userId, p_request_id: requestId },
  );
  if (error || typeof data !== "number" || !Number.isInteger(data) || data < 0) {
    throw new AppError(503, "UPLOAD_ADMISSION_UNAVAILABLE", "Unable to check upload capacity.");
  }
  return data;
}

export async function releaseCandidateDocumentDirectUpload(
  userId: string,
  requestId: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc(
    "release_candidate_document_direct_upload",
    { p_user_id: userId, p_request_id: requestId },
  );
  if (error || typeof data !== "boolean") {
    throw new AppError(503, "UPLOAD_ADMISSION_UNAVAILABLE", "Unable to release upload capacity.");
  }
  return data;
}

const parseMultipart: MultipartParser = (request, response) =>
  new Promise<void>((resolve, reject) => {
    candidateDocumentUpload.single("file")(request, response, error => {
      if (error) reject(error);
      else resolve();
    });
  });

/** Dependencies are injectable so admission ordering and release paths stay offline-testable. */
export function createCandidateDocumentDirectUploadHandler(dependencies: {
  acquire: AcquireLease;
  release: ReleaseLease;
  parseMultipart: MultipartParser;
  upload: AsyncHandler;
}) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const userId = request.auth?.userId;
    if (!userId) {
      next(new AppError(401, "UNAUTHENTICATED", "Authentication is required."));
      return;
    }

    const requestId = randomUUID();
    let retryAfter: number;
    try {
      retryAfter = await dependencies.acquire(userId, requestId);
    } catch (error) {
      next(error);
      return;
    }

    if (retryAfter > 0) {
      response.set("Retry-After", String(retryAfter)).status(429).json({
        error: {
          code: "UPLOAD_RATE_LIMITED",
          message: "Upload capacity is busy. Retry shortly.",
        },
      });
      return;
    }

    let requestError: unknown;
    let failed = false;
    try {
      // Admission must precede multer's memory buffer and any PDF sandbox work.
      await dependencies.parseMultipart(request, response);
      await dependencies.upload(request, response);
    } catch (error) {
      requestError = error;
      failed = true;
    }

    try {
      const released = await dependencies.release(userId, requestId);
      if (!released) console.error("Candidate upload admission lease was not released", { requestId });
    } catch {
      // Expiring leases recover if the request or database cannot release cleanly.
      console.error("Candidate upload admission lease release failed", { requestId });
    }

    if (failed) next(requestError);
  };
}

export const uploadCandidateDocumentWithAdmission = createCandidateDocumentDirectUploadHandler({
  acquire: acquireCandidateDocumentDirectUpload,
  release: releaseCandidateDocumentDirectUpload,
  parseMultipart,
  upload: uploadCandidateDocument,
});
