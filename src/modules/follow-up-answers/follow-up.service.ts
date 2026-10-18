import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";
import {
  assertActiveCv,
  loadCandidateSchema,
} from "../candidate/candidate-profile.service.js";
import { buildFollowUpPrompt } from "./follow-up.prompt.js";

const promptVersion = "1.0.0";

type ProviderResult = {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  };
};

export async function generateFollowUpAnswers(input: {
  userId: string;
  jobId: string;
  questions: string;
}) {
  // Confirm that the job belongs to this user.
  const { data: userJob, error: userJobError } = await supabaseAdmin
    .from("user_jobs")
    .select("job_id")
    .eq("user_id", input.userId)
    .eq("job_id", input.jobId)
    .maybeSingle();

  if (userJobError) throw userJobError;

  if (!userJob) {
    throw new AppError(
      404,
      "JOB_NOT_FOUND",
      "The selected job was not found in your account.",
    );
  }

  const { data: job, error: jobError } = await supabaseAdmin
    .from("jobs")
    .select("id, title, company_name, location, description")
    .eq("id", input.jobId)
    .single();

  if (jobError) throw jobError;

  // Load active CV.
  const { data: cv, error: cvError } = await supabaseAdmin
    .from("candidate_documents")
    .select("id, extracted_text")
    .eq("user_id", input.userId)
    .eq("document_type", "cv")
    .eq("is_active", true)
    .maybeSingle();

  if (cvError) throw cvError;

  if (!cv?.extracted_text?.trim()) {
    throw new AppError(
      409,
      "ACTIVE_CV_NOT_FOUND",
      "Upload a CV before answering follow-up questions.",
    );
  }

  // Load optional About You document.
  const { data: aboutYou, error: aboutYouError } = await supabaseAdmin
    .from("candidate_documents")
    .select("extracted_text")
    .eq("user_id", input.userId)
    .eq("document_type", "about_you")
    .eq("is_active", true)
    .maybeSingle();

  if (aboutYouError) throw aboutYouError;

  // Load the current skills profile.
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("candidate_profiles")
    .select("id, cv_document_id, skills_profile, schema_hash, policy_version")
    .eq("user_id", input.userId)
    .eq("cv_document_id", cv.id)
    .eq("is_current", true)
    .maybeSingle();

  if (profileError) throw profileError;

  if (!profile) {
    throw new AppError(
      409,
      "SKILLS_PROFILE_NOT_FOUND",
      "Generate your skills profile first.",
    );
  }

  const { schemaText, schemaHash, policyVersion } = await loadCandidateSchema();

  if (
    profile.schema_hash !== schemaHash ||
    profile.policy_version !== policyVersion
  ) {
    throw new AppError(
      409,
      "STALE_SKILLS_PROFILE",
      "Regenerate your skills profile before answering questions.",
    );
  }

  const skillsSchema = JSON.parse(schemaText);

  // A ranking is useful but optional, matching the old Flutter behaviour.
  const { data: ranking, error: rankingError } = await supabaseAdmin
    .from("job_rankings")
    .select("analysis")
    .eq("user_id", input.userId)
    .eq("job_id", input.jobId)
    .eq("candidate_profile_id", profile.id)
    .eq("status", "rated")
    .order("rated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (rankingError) throw rankingError;

  const model = process.env.QUESTION_ANSWERING_CODEX_MODEL;

  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  const prompt = buildFollowUpPrompt({
    questions: input.questions,
    jobTitle: job.title,
    companyName: job.company_name,
    location: job.location,
    jobDescription: job.description,
    cvContent: cv.extracted_text,
    skillsProfile: profile.skills_profile,
    skillsSchema,
    aboutYouContent: aboutYou?.extracted_text,
    candidateMatch: ranking?.analysis,
  });

  // Ensure that the CV is still active before calling the provider.
  await assertActiveCv(input.userId, cv.id);

  const providerResponse = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(120000),
    },
  );

  if (!providerResponse.ok) {
    const errorBody = await providerResponse.text();

    console.error("Follow-up provider failed:", {
      status: providerResponse.status,
      responseLength: errorBody.length,
    });

    throw new AppError(
      502,
      "FOLLOW_UP_PROVIDER_FAILED",
      "The follow-up-answer provider failed.",
    );
  }

  const providerResult = (await providerResponse.json()) as ProviderResult;

  const content = providerResult.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new AppError(
      502,
      "EMPTY_FOLLOW_UP_ANSWERS",
      "The provider returned an empty response.",
    );
  }

  // Prevent an answer generated from an old CV from being published.
  await assertActiveCv(input.userId, cv.id);

  const { data: document, error: documentError } = await supabaseAdmin
    .from("generated_documents")
    .insert({
      user_id: input.userId,
      job_id: input.jobId,
      candidate_profile_id: profile.id,
      document_type: "follow_up_answers",
      input_text: input.questions,
      content,
      model,
      prompt_version: promptVersion,
    })
    .select()
    .single();

  if (documentError) throw documentError;

  const { error: usageError } = await supabaseAdmin
    .from("generation_usage")
    .insert({
      user_id: input.userId,
      operation: "follow_up_answers",
      provider: "openrouter",
      model,
      input_tokens: providerResult.usage?.prompt_tokens ?? 0,
      output_tokens: providerResult.usage?.completion_tokens ?? 0,
      provider_request_id: providerResult.id ?? null,
      cost_usd: providerResult.usage?.cost ?? 0,
      status: "succeeded",
    });

  if (usageError) {
    console.error("Could not save follow-up-answer usage:", usageError);
  }

  return document;
}
