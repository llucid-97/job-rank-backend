import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { extractDocumentText } from "./document_text.service.js";
import { DocxResourceLimitError, UnsafeDocumentError } from "./docx-limits.js";
import { PdfResourceLimitError } from "./pdf-resource-limit.js";
import { PdfExtractionError } from "./pdf-extraction-error.js";
import { PdfSandboxConfigurationError } from "./pdf-sandbox-extraction.service.js";
import { retireFinalizedCandidateDocumentStaging } from "./candidate-document-staging-retirement.js";

const bucketName = "candidate-documents";
const stagingBucketName = "candidate-document-staging";
// The staging bucket has the same hard limit; this application check also
// protects the parser if project-level Storage settings are misconfigured.
export const maxStagedDocumentBytes = 15 * 1024 * 1024;
const maxNormalizedMarkdownBytes = 4 * 1024 * 1024;
const cleanupBatchSize = 100;
const cleanupTimeBudgetMs = 90_000;

class FinalizationConflictError extends Error {}

export function mapFinalizationDocumentError(error: unknown): { status: number; code: string; message: string } | null {
  if (error instanceof PdfResourceLimitError || error instanceof DocxResourceLimitError) {
    return { status: 413, code: "UNSAFE_DOCUMENT", message: error.message };
  }
  if (error instanceof UnsafeDocumentError) {
    return { status: 422, code: "INVALID_DOCUMENT", message: error.message };
  }
  if (error instanceof PdfExtractionError) {
    return { status: 422, code: "INVALID_DOCUMENT", message: error.message };
  }
  if (error instanceof PdfSandboxConfigurationError) {
    return { status: 503, code: "PDF_EXTRACTION_UNAVAILABLE", message: "PDF processing is temporarily unavailable." };
  }
  return null;
}

function normalizedMarkdown(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeFilename(value: unknown): string {
  if (typeof value !== "string") return "candidate-document.pdf";
  const leaf = value.split(/[\\/]/).pop() ?? "candidate-document";
  const filename = leaf.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return filename || "candidate-document.pdf";
}

function hasExpectedSignature(buffer: Buffer, filename: string): boolean {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (extension === "pdf") return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (extension === "docx") return buffer.subarray(0, 2).toString("ascii") === "PK";
  if (extension === "txt" || extension === "md") return !buffer.includes(0);
  return false;
}

/** Remove staged bytes after publication while retaining cron recovery on failure. */
async function retireFinalizedUploadStaging(userId: string, uploadId: string) {
  const result = await retireFinalizedCandidateDocumentStaging(
    { userId, uploadId, sourcePath: `${userId}/${uploadId}/source` },
    {
      claim: async (ownerId, id, claimToken) => {
        const { data, error } = await supabaseAdmin.rpc(
          "claim_finalized_candidate_document_upload_retirement",
          { p_id: id, p_user_id: ownerId, p_claim_token: claimToken },
        );
        if (error) throw error;
        if (!["claimed", "not_found", "not_finalized", "busy"].includes(data)) {
          throw new Error("Upload staging retirement claim returned an invalid result.");
        }
        return data;
      },
      removeSource: sourcePath =>
        supabaseAdmin.storage.from(stagingBucketName).remove([sourcePath]),
      releaseClaim: async (_ownerId, id, claimToken) => {
        const { error } = await supabaseAdmin.rpc(
          "release_candidate_document_upload_cleanup",
          { p_claim_token: claimToken, p_ids: [id] },
        );
        if (error) throw error;
      },
    },
  );

  if (!result.ok) {
    console.error("Candidate staging retirement deferred", {
      uploadId,
      stage: result.stage,
      errorCode:
        typeof result.error === "object" && result.error !== null && "code" in result.error
          ? result.error.code
          : result.error ? "UNKNOWN" : undefined,
    });
  }
}

/** Create an owner-bound, single-object signed upload into the private quarantine bucket. */
export async function createCandidateDocumentUpload(
  request: Request,
  response: Response,
) {
  const userId = request.auth!.userId;
  const uploadId = randomUUID();
  const stagingPath = `${userId}/${uploadId}/source`;
  const purgeAfter = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();

  const { data: intentCreated, error: intentError } = await supabaseAdmin.rpc(
    "create_candidate_document_upload_intent",
    { p_id: uploadId, p_user_id: userId, p_purge_after: purgeAfter },
  );
  if (intentError) throw intentError;
  if (intentCreated !== true) {
    return response.status(429).json({
      error: { code: "UPLOAD_LIMIT_REACHED", message: "You have reached the upload limit. Finish or wait for a pending upload, or try again later." },
    });
  }

  const { data, error } = await supabaseAdmin.storage
    .from(stagingBucketName)
    .createSignedUploadUrl(stagingPath, { upsert: false });
  if (error || !data) {
    await supabaseAdmin.from("candidate_document_upload_intents").delete()
      .eq("id", uploadId).eq("user_id", userId);
    throw error ?? new Error("Could not create a signed upload URL.");
  }

  return response.status(201).json({
    data: { uploadId, path: data.path, token: data.token, bucket: stagingBucketName,
      maxBytes: maxStagedDocumentBytes },
  });
}

/** Validate, convert and persist only normalized Markdown; the original stays in expiring staging. */
export async function finalizeCandidateDocumentUpload(
  request: Request,
  response: Response,
) {
  const userId = request.auth!.userId;
  const uploadId = request.body?.uploadId;
  const documentType = request.body?.documentType;
  const originalFilename = request.body?.filename;
  if (typeof uploadId !== "string" || !/^[0-9a-f-]{36}$/i.test(uploadId)) {
    return response.status(400).json({ error: { code: "INVALID_UPLOAD_ID", message: "Upload could not be finalized." } });
  }
  if (!["cv", "about_you"].includes(documentType)) {
    return response.status(400).json({ error: { code: "INVALID_DOCUMENT_TYPE", message: "Document type must be cv or about_you." } });
  }

  const documentColumns = "id, user_id, document_type, filename, storage_path, extracted_text, content_hash, revision, is_active, created_at, updated_at";
  const displayFilename = safeFilename(originalFilename);
  const stagingPath = `${userId}/${uploadId}/source`;
  const { data: alreadyFinalized, error: existingError } = await supabaseAdmin
    .from("candidate_documents").select(documentColumns)
    .eq("id", uploadId).eq("user_id", userId).maybeSingle();
  if (existingError) throw existingError;
  if (alreadyFinalized) {
    if (alreadyFinalized.document_type !== documentType || alreadyFinalized.filename !== displayFilename) {
      return response.status(409).json({ error: { code: "UPLOAD_ALREADY_FINALIZED", message: "This upload was finalized with different details. Please select the file again." } });
    }
    await retireFinalizedUploadStaging(userId, uploadId);
    return response.status(201).json({ data: alreadyFinalized });
  }

  const originalExtension = typeof originalFilename === "string"
    ? originalFilename.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() : "";
  const sourceMime = originalExtension === "pdf" ? "application/pdf"
    : originalExtension === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : ["md", "txt"].includes(originalExtension ?? "") ? "text/plain" : "";
  if (!sourceMime) return response.status(400).json({ error: { code: "UNSUPPORTED_DOCUMENT_TYPE", message: "Choose a PDF, DOCX, TXT or MD file." } });

  const finalPath = `${userId}/${uploadId}/document.md`;
  const claimToken = randomUUID();
  let documentId: string | undefined;
  let finalizationClaimed = false;
  let finalizationCompleted = false;
  let publicationAttempted = false;
  let expected: { documentType: string; filename: string; storagePath: string; extractedText: string; contentHash: string } | undefined;
  let databaseRejected = false;

  try {
    const { data: claimStatus, error: claimError } = await supabaseAdmin.rpc(
      "claim_candidate_document_upload_finalization",
      { p_id: uploadId, p_user_id: userId, p_claim_token: claimToken, p_final_storage_path: finalPath },
    );
    if (claimError) throw claimError;
    if (claimStatus === "busy" || claimStatus === "cleanup_in_progress") {
      return response.status(409).json({ error: { code: "UPLOAD_FINALIZATION_IN_PROGRESS", message: "This upload is still being finalized. Retry after a few minutes." } });
    }
    if (claimStatus === "expired" || claimStatus === "not_found") {
      return response.status(404).json({ error: { code: "UPLOAD_NOT_FOUND", message: "Upload expired. Please select the file again." } });
    }
    if (claimStatus === "conflict") {
      return response.status(409).json({ error: { code: "UPLOAD_ALREADY_FINALIZED", message: "This upload was finalized with different details. Please select the file again." } });
    }
    if (claimStatus === "completed") {
      const { data: completedDocument, error: completedLookupError } = await supabaseAdmin
        .from("candidate_documents").select(documentColumns)
        .eq("id", uploadId).eq("user_id", userId).maybeSingle();
      if (completedLookupError) throw completedLookupError;
      if (completedDocument
          && completedDocument.document_type === documentType
          && completedDocument.filename === displayFilename) {
        await retireFinalizedUploadStaging(userId, uploadId);
        return response.status(201).json({ data: completedDocument });
      }
      return response.status(409).json({ error: { code: "UPLOAD_ALREADY_FINALIZED", message: "This upload was finalized with different details. Please select the file again." } });
    }
    if (claimStatus !== "claimed") throw new Error("Unexpected document finalization claim status.");
    finalizationClaimed = true;
    documentId = uploadId;

    const { data: blob, error: downloadError } = await supabaseAdmin.storage.from(stagingBucketName).download(stagingPath);
    if (downloadError || !blob) return response.status(422).json({ error: { code: "UPLOAD_INCOMPLETE", message: "The file upload is incomplete. Please try again." } });
    if (blob.size <= 0 || blob.size > maxStagedDocumentBytes) {
      return response.status(422).json({ error: { code: "INVALID_DOCUMENT", message: "The file is empty or too large." } });
    }
    const bytes = Buffer.from(await blob.arrayBuffer());
    if (!bytes.length || bytes.length > maxStagedDocumentBytes || !hasExpectedSignature(bytes, originalExtension ? `file.${originalExtension}` : "")) {
      return response.status(422).json({ error: { code: "INVALID_DOCUMENT", message: "The file is empty, too large, or does not match its file type." } });
    }

    const markdown = normalizedMarkdown(await extractDocumentText(bytes, sourceMime));
    if (!markdown) return response.status(422).json({ error: { code: "NO_EXTRACTABLE_TEXT", message: "No text could be extracted from this document." } });
    if (Buffer.byteLength(markdown, "utf8") > maxNormalizedMarkdownBytes) {
      return response.status(413).json({ error: { code: "NORMALIZED_DOCUMENT_TOO_LARGE", message: "The extracted document is too large to save. Please use a shorter document." } });
    }
    // Reusing the upload UUID makes a successful finalization safe to retry
    // after an HTTP response is lost.
    const contentHash = createHash("sha256").update(markdown, "utf8").digest("hex");
    expected = { documentType, filename: displayFilename, storagePath: finalPath, extractedText: markdown, contentHash };
    const markdownBytes = Buffer.from(markdown, "utf8");
    const { error: storageError } = await supabaseAdmin.storage.from(bucketName).upload(
      finalPath, markdownBytes, { contentType: "text/markdown", upsert: false },
    );
    if (storageError) {
      // A prior attempt may have uploaded this exact object before its database
      // RPC failed ambiguously. Reuse only byte-identical content.
      const { data: priorObject, error: priorObjectError } = await supabaseAdmin.storage.from(bucketName).download(finalPath);
      if (priorObjectError || !priorObject) throw storageError;
      if (!Buffer.from(await priorObject.arrayBuffer()).equals(markdownBytes)) {
        throw new FinalizationConflictError("A different Markdown object already occupies this upload path.");
      }
    }

    // Once this request crosses the atomic publication RPC boundary, a lost
    // response cannot tell us whether the transaction committed. Keep the
    // lease unless Postgres returns a definitive transaction rejection.
    publicationAttempted = true;
    const { data: document, error: databaseError } = await supabaseAdmin.rpc("complete_candidate_document_upload_finalization", {
      p_id: documentId, p_user_id: userId, p_document_type: documentType,
      p_filename: displayFilename, p_storage_path: finalPath,
      p_extracted_text: markdown, p_content_hash: contentHash,
      p_claim_token: claimToken,
    }).single();
    if (databaseError) {
      databaseRejected = /^(22|23)[A-Z0-9]{3}$/.test(databaseError.code) || ["40001", "40P01", "42501", "42883", "P0001"].includes(databaseError.code);
      throw databaseError;
    }
    if (!document) throw new Error("Document replacement returned no record.");
    finalizationCompleted = true;
    await retireFinalizedUploadStaging(userId, uploadId);
    return response.status(201).json({ data: document });
  } catch (error) {
    if (documentId) {
      const { data: currentDocument, error: lookupError } = await supabaseAdmin
        .from("candidate_documents").select(documentColumns)
        .eq("id", documentId).eq("user_id", userId).maybeSingle();
      if (!lookupError && currentDocument) {
        const matchesAttempt = expected !== undefined
          && currentDocument.document_type === expected.documentType
          && currentDocument.filename === expected.filename
          && currentDocument.storage_path === expected.storagePath
          && currentDocument.extracted_text === expected.extractedText
          && currentDocument.content_hash === expected.contentHash;
        if (matchesAttempt) {
          await retireFinalizedUploadStaging(userId, uploadId);
          return response.status(201).json({ data: currentDocument });
        }
        return response.status(409).json({ error: { code: "UPLOAD_ALREADY_FINALIZED", message: "This upload was finalized with different details. Please select the file again." } });
      }
    }
    const documentError = mapFinalizationDocumentError(error);
    if (documentError) return response.status(documentError.status).json({ error: { code: documentError.code, message: documentError.message } });
    if (error instanceof FinalizationConflictError) {
      return response.status(409).json({ error: { code: "UPLOAD_OBJECT_CONFLICT", message: "This upload could not be resumed safely. Please select the file again." } });
    }
    if (finalPath && !databaseRejected) {
      return response.status(503).json({ error: { code: "DOCUMENT_UPLOAD_RETRYABLE", message: "The upload result is uncertain. Please retry finalization." } });
    }
    console.error("Candidate document finalize failed:", {
      uploadId, documentId, stage: finalPath ? "saving document" : "extracting document",
      errorCode: typeof error === "object" && error !== null && "code" in error ? error.code : "UNKNOWN",
    });
    return response.status(500).json({ error: { code: "DOCUMENT_UPLOAD_FAILED", message: "Document upload failed." } });
  } finally {
    if (finalizationClaimed && !finalizationCompleted && (!publicationAttempted || databaseRejected)) {
      await Promise.resolve(supabaseAdmin.rpc("release_candidate_document_upload_finalization", {
        p_id: uploadId, p_user_id: userId, p_claim_token: claimToken,
      })).catch(() => undefined);
    }
  }
}

/** Remove expired quarantine objects until the function approaches its runtime budget. */
export async function cleanupCandidateDocumentUploads(request: Request, response: Response) {
  const secret = env.CRON_SECRET;
  if (!secret || request.headers.authorization !== `Bearer ${secret}`) {
    return response.status(401).json({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } });
  }
  const cleanupDeadline = Date.now() + cleanupTimeBudgetMs;
  let examined = 0;
  let removed = 0;
  while (Date.now() < cleanupDeadline) {
    const cleanupClaimToken = randomUUID();
    const { data: intents, error } = await supabaseAdmin.rpc(
      "claim_candidate_document_uploads_for_cleanup",
      { p_claim_token: cleanupClaimToken, p_limit: cleanupBatchSize },
    );
    if (error) throw error;
    const batch = (intents ?? []) as Array<{ id: string; user_id: string; final_storage_path: string | null }>;
    if (batch.length === 0) break;
    const first = batch[0]!;
    examined += batch.length;
    const ids = batch.map(intent => intent.id);
    let cleanupStage = "removing objects";
    try {
      const sourcePaths = batch.map(intent => `${intent.user_id}/${intent.id}/source`);
      const finalPaths = batch.flatMap(intent => intent.final_storage_path ? [intent.final_storage_path] : []);
      let referencedFinalPaths = new Set<string>();
      if (finalPaths.length > 0) {
        const { data: referencedDocuments, error: referenceError } = await supabaseAdmin
          .from("candidate_documents").select("storage_path").in("storage_path", finalPaths);
        if (referenceError) throw referenceError;
        referencedFinalPaths = new Set((referencedDocuments ?? []).map(document => document.storage_path));
      }
      const orphanFinalPaths = finalPaths.filter(path => !referencedFinalPaths.has(path));
      const { error: stagingStorageError } = await supabaseAdmin.storage.from(stagingBucketName).remove(sourcePaths);
      if (stagingStorageError) throw stagingStorageError;
      if (orphanFinalPaths.length > 0) {
        cleanupStage = "removing orphan documents";
        const { error: finalStorageError } = await supabaseAdmin.storage.from(bucketName).remove(orphanFinalPaths);
        if (finalStorageError) throw finalStorageError;
      }
      cleanupStage = "removing intents";
      const { data: deletedCount, error: deleteError } = await supabaseAdmin.rpc(
        "delete_candidate_document_uploads_after_cleanup",
        { p_claim_token: cleanupClaimToken, p_ids: ids },
      );
      if (deleteError) throw deleteError;
      if (deletedCount !== batch.length) throw new Error("Cleanup claim changed before intent deletion.");
      removed += deletedCount;
    } catch (cleanupError) {
      await Promise.resolve(supabaseAdmin.rpc("release_candidate_document_upload_cleanup", {
        p_claim_token: cleanupClaimToken, p_ids: ids,
      })).catch(() => undefined);
      console.error("Candidate staging cleanup failed:", {
        uploadId: first.id, count: batch.length, stage: cleanupStage,
        errorCode: typeof cleanupError === "object" && cleanupError !== null && "code" in cleanupError
          ? cleanupError.code : "UNKNOWN",
      });
      return response.status(503).json({ error: { code: "STAGING_CLEANUP_FAILED", message: "Staging cleanup failed; retry the job." }, data: { examined, removed } });
    }
  }
  return response.status(200).json({ data: { examined, removed, hasMore: Date.now() >= cleanupDeadline } });
}

export async function uploadCandidateDocument(
  request: Request,
  response: Response,
) {
  let stage = "starting";
  let documentId: string | undefined;
  let storagePath: string | undefined;
  let databaseRejected = false;

  try {
    const userId = request.auth?.userId;
    const file = request.file;
    const documentType = request.body.documentType;

    if (!file) {
      return response.status(400).json({
        error: {
          code: "FILE_REQUIRED",
          message: "Please select a file.",
        },
      });
    }

    if (!["cv", "about_you"].includes(documentType)) {
      return response.status(400).json({
        error: {
          code: "INVALID_DOCUMENT_TYPE",
          message: "Document type must be cv or about_you.",
        },
      });
    }

    stage = "extracting text";

    const extractedText = normalizedMarkdown(await extractDocumentText(file.buffer, file.mimetype));

    if (!extractedText) {
      return response.status(422).json({
        error: {
          code: "NO_EXTRACTABLE_TEXT",
          message: "No text could be extracted from this document.",
        },
      });
    }

    documentId = randomUUID();

    storagePath = `${userId}/${documentId}/document.md`;

    const contentHash = createHash("sha256").update(extractedText, "utf8").digest("hex");

    stage = "uploading to storage";

    const { error: storageError } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(storagePath, Buffer.from(extractedText, "utf8"), {
        contentType: "text/markdown",
        upsert: false,
      });

    if (storageError) {
      throw storageError;
    }

    stage = "saving document";

    const { data: document, error: databaseError } = await supabaseAdmin
      .rpc("replace_candidate_document", {
        p_id: documentId,
        p_user_id: userId,
        p_document_type: documentType,
        p_filename: file.originalname,
        p_storage_path: storagePath,
        p_extracted_text: extractedText,
        p_content_hash: contentHash,
      })
      .single();

    if (databaseError) {
      // These errors confirm rollback. Connection/response errors may follow a
      // successful commit, so they must not cause deletion of the stored file.
      databaseRejected =
        /^(22|23)[A-Z0-9]{3}$/.test(databaseError.code) ||
        ["40001", "40P01", "42501", "42883", "P0001"].includes(databaseError.code);
      throw databaseError;
    }

    if (!document) throw new Error("Document replacement returned no record.");

    return response.status(201).json({
      data: document,
    });
  } catch (error) {
    if (error instanceof UnsafeDocumentError || error instanceof PdfResourceLimitError) {
      return response.status(413).json({ error: { code: "UNSAFE_DOCUMENT", message: error.message } });
    }
    if (error instanceof PdfExtractionError) {
      return response.status(422).json({ error: { code: "INVALID_DOCUMENT", message: error.message } });
    }
    if (error instanceof PdfSandboxConfigurationError) {
      return response.status(503).json({ error: { code: "PDF_EXTRACTION_UNAVAILABLE", message: "PDF processing is temporarily unavailable." } });
    }
    // Clean up only after confirmed rollback; preserve files when the commit outcome is uncertain.
    let storageAction = "preserved; confirm upload/database outcome before cleanup";
    if (databaseRejected && storagePath) {
      try {
        const { error: cleanupError } = await supabaseAdmin.storage
          .from(bucketName)
          .remove([storagePath]);
        storageAction = cleanupError ? "cleanup failed; retry removal" : "removed";
      } catch {
        storageAction = "cleanup failed; retry removal";
      }
    }

    // Database errors can include extracted CV text. Log only identifiers needed
    // to reconcile a failed/uncertain upload, never its content or raw error.
    console.error("Candidate upload failed:", {
      stage,
      documentId,
      storagePath,
      storageAction,
      errorCode:
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : "UNKNOWN",
    });

    return response.status(500).json({
      error: {
        code: "DOCUMENT_UPLOAD_FAILED",
        message: "Document upload failed.",
      },
    });
  }
}
export async function listCandidateDocuments(
  request: Request,
  response: Response,
) {
  const { data, error } = await supabaseAdmin
    .from("candidate_documents")
    .select(
      `
    id,
    document_type,
    filename,
    extracted_text,
    revision,
    is_active,
    created_at,
    updated_at
  `,
    )
    .eq("user_id", request.auth?.userId)
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return response.status(200).json({
    data,
  });
}

/** Deactivate only the requested owned document, preserving history and later replacements. */
export async function deactivateCandidateDocument(
  request: Request,
  response: Response,
) {
  const { error } = await supabaseAdmin
    .from("candidate_documents")
    .update({ is_active: false })
    .eq("id", request.params.id)
    .eq("user_id", request.auth!.userId)
    .eq("is_active", true);

  if (error) throw error;

  return response.status(204).send();
}
