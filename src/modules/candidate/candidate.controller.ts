import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { extractDocumentText } from "./document_text.service.js";
import { UnsafeDocumentError } from "./docx-limits.js";
import { PdfResourceLimitError } from "./pdf-resource-limit.js";

const bucketName = "candidate-documents";
const stagingBucketName = "candidate-document-staging";
// The staging bucket has the same hard limit; this application check also
// protects the parser if project-level Storage settings are misconfigured.
export const maxStagedDocumentBytes = 15 * 1024 * 1024;
const maxNormalizedMarkdownBytes = 4 * 1024 * 1024;
const cleanupBatchSize = 100;
const cleanupTimeBudgetMs = 90_000;

class FinalizationConflictError extends Error {}

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
      error: { code: "UPLOAD_LIMIT_REACHED", message: "You have reached the limit of five unpurged uploads. Please try again after staging cleanup runs." },
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

  const { data: intent, error: intentError } = await supabaseAdmin
    .from("candidate_document_upload_intents")
    .select("id, purge_after")
    .eq("id", uploadId)
    .eq("user_id", userId)
    .maybeSingle();
  if (intentError) throw intentError;
  if (!intent || new Date(intent.purge_after).getTime() <= Date.now()) {
    return response.status(404).json({ error: { code: "UPLOAD_NOT_FOUND", message: "Upload expired. Please select the file again." } });
  }

  const documentColumns = "id, user_id, document_type, filename, storage_path, extracted_text, content_hash, revision, is_active, created_at, updated_at";
  const { data: alreadyFinalized, error: existingError } = await supabaseAdmin
    .from("candidate_documents").select(documentColumns)
    .eq("id", uploadId).eq("user_id", userId).maybeSingle();
  if (existingError) throw existingError;
  if (alreadyFinalized) return response.status(201).json({ data: alreadyFinalized });

  const stagingPath = `${userId}/${uploadId}/source`;
  const displayFilename = safeFilename(originalFilename);
  const originalExtension = typeof originalFilename === "string"
    ? originalFilename.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() : "";
  const sourceMime = originalExtension === "pdf" ? "application/pdf"
    : originalExtension === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : ["md", "txt"].includes(originalExtension ?? "") ? "text/plain" : "";
  let finalPath: string | undefined;
  let documentId: string | undefined;
  let expected: { documentType: string; filename: string; storagePath: string; extractedText: string; contentHash: string } | undefined;
  let databaseRejected = false;

  try {
    if (!sourceMime) return response.status(400).json({ error: { code: "UNSUPPORTED_DOCUMENT_TYPE", message: "Choose a PDF, DOCX, TXT or MD file." } });
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
    documentId = uploadId;
    finalPath = `${userId}/${documentId}/document.md`;
    const { error: intentUpdateError } = await supabaseAdmin.from("candidate_document_upload_intents")
      .update({ final_storage_path: finalPath }).eq("id", uploadId).eq("user_id", userId);
    if (intentUpdateError) throw intentUpdateError;
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

    const { data: document, error: databaseError } = await supabaseAdmin.rpc("replace_candidate_document", {
      p_id: documentId, p_user_id: userId, p_document_type: documentType,
      p_filename: displayFilename, p_storage_path: finalPath,
      p_extracted_text: markdown, p_content_hash: contentHash,
    }).single();
    if (databaseError) {
      databaseRejected = /^(22|23)[A-Z0-9]{3}$/.test(databaseError.code) || ["40001", "40P01", "42501", "42883", "P0001"].includes(databaseError.code);
      throw databaseError;
    }
    if (!document) throw new Error("Document replacement returned no record.");
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
        if (matchesAttempt) return response.status(201).json({ data: currentDocument });
        return response.status(409).json({ error: { code: "UPLOAD_ALREADY_FINALIZED", message: "This upload was finalized with different details. Please select the file again." } });
      }
    }
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
    const { data: intents, error } = await supabaseAdmin.from("candidate_document_upload_intents")
      .select("id, user_id, final_storage_path").lt("purge_after", new Date().toISOString())
      .order("purge_after", { ascending: true }).limit(cleanupBatchSize);
    if (error) throw error;
    const batch = intents ?? [];
    if (batch.length === 0) break;
    const first = batch[0]!;
    examined += batch.length;
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
      const paths = [...sourcePaths, ...orphanFinalPaths];
      const { error: storageError } = await supabaseAdmin.storage.from(stagingBucketName).remove(paths);
      if (storageError) {
        console.error("Candidate staging cleanup failed:", {
          uploadId: first.id, count: batch.length, stage: "removing objects", errorCode: "STORAGE_ERROR",
        });
        return response.status(503).json({ error: { code: "STAGING_CLEANUP_FAILED", message: "Staging cleanup failed; retry the job." }, data: { examined, removed } });
      }
      const { error: deleteError } = await supabaseAdmin.from("candidate_document_upload_intents")
        .delete().in("id", batch.map(intent => intent.id));
      if (deleteError) {
        console.error("Candidate staging cleanup failed:", {
          uploadId: first.id, count: batch.length, stage: "removing intents", errorCode: deleteError.code ?? "UNKNOWN",
        });
        return response.status(503).json({ error: { code: "STAGING_CLEANUP_FAILED", message: "Staging cleanup failed; retry the job." }, data: { examined, removed } });
      }
      removed += batch.length;
    } catch (cleanupError) {
      console.error("Candidate staging cleanup failed:", {
        uploadId: first.id, count: batch.length, stage: "removing objects",
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
