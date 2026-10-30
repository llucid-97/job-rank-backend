import { ownerJob } from "../jobs/owner-job.js";
import { consumeQuota } from "../provider-proxy/provider-quota.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";
import { loadCandidateSchema } from "../candidate/candidate-profile.service.js";
import { buildCoverLetterPrompt } from "./cover-letter.prompt.js";

const promptVersion = "1.0.0";

export async function generateCoverLetter(input: {
  userId: string;
  jobId: string;
  tone: string;
}) {
  // Confirm that this job belongs to the user.
  const { data: userJob, error: userJobError } = await supabaseAdmin
    .from("user_jobs")
    .select("job_id,workspace_data")
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
    .select("id, title, company_name, description, location")
    .eq("id", input.jobId)
    .single();

  if (jobError) throw jobError;
  const ownedJob = ownerJob(job, userJob.workspace_data);

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
      "Upload a CV before generating a cover letter.",
    );
  }

  // Load optional About You document.
  const { data: aboutYou, error: aboutError } = await supabaseAdmin
    .from("candidate_documents")
    .select("extracted_text")
    .eq("user_id", input.userId)
    .eq("document_type", "about_you")
    .eq("is_active", true)
    .maybeSingle();

  if (aboutError) throw aboutError;

  // Load the skills profile associated with this CV.
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("candidate_profiles")
    .select("id, skills_profile")
    .eq("user_id", input.userId)
    .eq("cv_document_id", cv.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (profileError) throw profileError;

  if (!profile) {
    throw new AppError(
      409,
      "SKILLS_PROFILE_NOT_FOUND",
      "Generate your skills profile first.",
    );
  }

  // Ranking is useful but optional.
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

  const model = process.env.COVER_LETTER_MODEL ?? "openai/gpt-5.6-luna";

  const { schemaText } = await loadCandidateSchema();
  const skillsSchema = JSON.parse(schemaText);

  await consumeQuota(input.userId, "llm", 1);

  const providerResponse = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: buildCoverLetterPrompt({
              jobTitle: ownedJob.title,
              companyName: ownedJob.company_name,
              location: ownedJob.location,
              jobDescription: ownedJob.description,
              cvContent: cv.extracted_text,
              aboutYouContent: aboutYou?.extracted_text,
              skillsProfile: profile.skills_profile,
              skillsSchema,
              candidateMatch: ranking?.analysis,
              tone: input.tone,
            }),
          },
        ],
        temperature: 0.4,
      }),
      signal: AbortSignal.timeout(120000),
    },
  );

  if (!providerResponse.ok) {
    throw new AppError(
      502,
      "COVER_LETTER_PROVIDER_FAILED",
      "The cover-letter provider failed.",
    );
  }

  const providerResult = (await providerResponse.json()) as {
    id?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      cost?: number;
    };
  };

  const content = providerResult.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new AppError(
      502,
      "EMPTY_COVER_LETTER",
      "The provider returned an empty cover letter.",
    );
  }

  // Lock and verify the source CV in the same transaction that publishes the
  // letter. A plain read here would still race a replacement/deactivation.
  const { data: document, error: documentError } = await supabaseAdmin.rpc(
    "publish_cover_letter_for_active_cv",
    {
      p_user_id: input.userId,
      p_cv_document_id: cv.id,
      p_candidate_profile_id: profile.id,
      p_job_id: input.jobId,
      p_content: content,
      p_model: model,
      p_prompt_version: promptVersion,
    },
  ).single();

  if (documentError?.code === "P0001") {
    throw new AppError(409, "CANDIDATE_CONTEXT_CHANGED", "Your CV changed while the cover letter was being generated. Please try again.");
  }
  if (documentError) throw documentError;

  const { error: usageError } = await supabaseAdmin
    .from("generation_usage")
    .insert({
      user_id: input.userId,
      operation: "cover_letter",
      provider: "openrouter",
      model,
      input_tokens: providerResult.usage?.prompt_tokens ?? 0,
      output_tokens: providerResult.usage?.completion_tokens ?? 0,
      provider_request_id: providerResult.id ?? null,
      cost_usd: providerResult.usage?.cost ?? 0,
      status: "succeeded",
    });

  if (usageError) {
    console.error("Could not save cover-letter usage:", usageError);
  }

  return document;
}
