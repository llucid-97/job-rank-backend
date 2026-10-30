import { createHash, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { supabaseAdmin } from "../../config/supabase.js";
import { extractDocumentText } from "./document_text.service.js";
import { UnsafeDocumentError } from "./docx-limits.js";

const bucketName = "candidate-documents";

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

    const extractedText = await extractDocumentText(file.buffer, file.mimetype);

    if (!extractedText) {
      return response.status(422).json({
        error: {
          code: "NO_EXTRACTABLE_TEXT",
          message: "No text could be extracted from this document.",
        },
      });
    }

    documentId = randomUUID();

    const safeFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

    storagePath = `${userId}/${documentId}/${safeFilename}`;

    const contentHash = createHash("sha256").update(file.buffer).digest("hex");

    stage = "uploading to storage";

    const { error: storageError } = await supabaseAdmin.storage
      .from(bucketName)
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
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
    if (error instanceof UnsafeDocumentError) {
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
