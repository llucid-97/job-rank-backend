import type { Request, Response } from "express";
import {
  assertActiveCv,
  CandidateContextChangedError,
  generateCandidateProfile,
  hashCandidateText,
  loadCandidateSchema,
  validateSkillsProfile,
} from "./candidate-profile.service.js";
import { AppError } from "../../middleware/error-handling.js";
import { supabaseAdmin } from "../../config/supabase.js";

/** Return generated skills with their current schema, or a retryable candidate-change response. */
export async function generateSkillsProfile(
  request: Request,
  response: Response,
) {
  const documentId = request.body.documentId;

  if (typeof documentId !== "string" || !documentId) {
    return response.status(400).json({
      error: {
        code: "DOCUMENT_ID_REQUIRED",
        message: "A CV document ID is required.",
      },
    });
  }

  // Publish only after the saved profile still matches the active CV and schema.
  try {
    const result = await generateCandidateProfile(
      request.auth!.userId,
      documentId,
    );
    const schema = await loadCandidateSchema();
    if (
      result.profile.schema_hash !== schema.schemaHash ||
      result.profile.policy_version !== schema.policyVersion
    ) {
      throw new CandidateContextChangedError();
    }
    await assertActiveCv(request.auth!.userId, documentId);

    return response.status(result.generated ? 201 : 200).json({
      data: {
        ...result.profile,
        schema_json: schema.schemaText,
        generated: result.generated,
      },
    });
  } catch (error) {
    if (!(error instanceof CandidateContextChangedError)) throw error;
    return response.status(409).json({
      error: { code: "CANDIDATE_CONTEXT_CHANGED", message: error.message },
    });
  }
}

/** Expose only the current CV profile with matching schema and policy so stale skills are not reused. */
export async function getActiveSkillsProfile(
  request: Request,
  response: Response,
) {
  const { data: document, error: documentError } = await supabaseAdmin
    .from("candidate_documents")
    .select("id")
    .eq("user_id", request.auth?.userId)
    .eq("document_type", "cv")
    .eq("is_active", true)
    .maybeSingle();

  if (documentError) throw documentError;

  if (!document) {
    return response.status(404).json({
      error: {
        code: "ACTIVE_CV_NOT_FOUND",
        message: "No active CV was found.",
      },
    });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("candidate_profiles")
    .select(
      `
          id,
          cv_document_id,
          skills_profile,
          cv_hash,
          schema_hash,
          policy_version,
          model,
          created_at
        `,
    )
    .eq("user_id", request.auth?.userId)
    .eq("cv_document_id", document.id)
    .eq("is_current", true)
    .maybeSingle();

  if (profileError) throw profileError;

  if (!profile) return response.status(200).json({ data: null });

  const schema = await loadCandidateSchema();
  if (
    profile.schema_hash !== schema.schemaHash ||
    profile.policy_version !== schema.policyVersion
  ) {
    return response.status(200).json({ data: null });
  }

  try {
    await assertActiveCv(request.auth!.userId, document.id);
  } catch (error) {
    if (!(error instanceof CandidateContextChangedError)) throw error;
    return response.status(200).json({ data: null });
  }

  return response.status(200).json({
    data: { ...profile, schema_json: schema.schemaText },
  });
}

/** Save a user-edited profile as a new immutable revision. */
export async function updateSkillsProfile(request: Request, response: Response) {
  const { expectedProfileId, skillsProfile } = request.body ?? {};
  if (typeof expectedProfileId !== "string" || !expectedProfileId) {
    throw new AppError(400, "EXPECTED_PROFILE_ID_REQUIRED", "The expected profile ID is required.");
  }

  const validationErrors = await validateSkillsProfile(skillsProfile);
  if (validationErrors) {
    throw new AppError(422, "INVALID_SKILLS_PROFILE", "The edited profile does not match the skills schema.", validationErrors);
  }

  const userId = request.auth!.userId;
  const { data: document, error: documentError } = await supabaseAdmin
    .from("candidate_documents")
    .select("id, extracted_text")
    .eq("user_id", userId)
    .eq("document_type", "cv")
    .eq("is_active", true)
    .maybeSingle();
  if (documentError) throw documentError;
  if (!document || !document.extracted_text?.trim()) {
    throw new AppError(409, "ACTIVE_CV_NOT_FOUND", "No active CV was found.");
  }

  const { data: current, error: currentError } = await supabaseAdmin
    .from("candidate_profiles")
    .select("id")
    .eq("user_id", userId)
    .eq("cv_document_id", document.id)
    .eq("is_current", true)
    .maybeSingle();
  if (currentError) throw currentError;
  if ((current?.id ?? null) !== expectedProfileId) {
    throw new AppError(409, "PROFILE_CONFLICT", "Your skills profile changed. Reload it before saving.");
  }

  const { schemaHash, policyVersion } = await loadCandidateSchema();
  const { data: profile, error: profileError } = await supabaseAdmin.rpc(
    "publish_candidate_profile",
    {
      p_user_id: userId,
      p_cv_document_id: document.id,
      p_expected_profile_id: expectedProfileId,
      p_cv_hash: hashCandidateText(document.extracted_text),
      p_schema_hash: schemaHash,
      p_policy_version: policyVersion,
      p_skills_profile: skillsProfile,
      p_model: "user_edit",
    },
  );
  if (profileError) {
    if (profileError.code === "P0001") {
      throw new AppError(409, "PROFILE_CONFLICT", "Your skills profile or active CV changed. Reload before saving.");
    }
    throw profileError;
  }
  if (!profile) {
    throw new AppError(409, "PROFILE_CONFLICT", "Your skills profile changed. Reload it before saving.");
  }

  const schema = await loadCandidateSchema();
  return response.status(200).json({ data: { ...profile, schema_json: schema.schemaText } });
}
