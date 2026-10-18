import { createHash } from "node:crypto";
import { rankingConfiguration, rankingVersion } from "./ranking.configuration.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { buildRankingPrompt } from "./ranking.prompt.js";
import { calculateCandidateScore } from "./ranking.score.js";

import { rankWithJev, scoreProjection, validateAnalysis } from "./ranking.projection.js";
import { assessRequiredRequirements } from "./ranking.requirements.js";
import { assertActiveCv, loadCandidateSchema } from "../candidate/candidate-profile.service.js";


type DatabaseJob = {
  id: string;
  title: string;
  description: string;
  location: string | null;
  provider_payload: Record<string, unknown> | null;
};

type RankingContext = {
  runId: string;
  userId: string | undefined;
  candidateProfileId: string;
  cvContent: string;
  skillsProfile: unknown;
  schema: unknown;
  model: string;
  classifier: "jev" | "llm";
  cvDocumentId: string;
};

type OpenRouterResult = {
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

function requiredEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is not configured.`);
  }

  return value;
}

function parseGeneratedJson(content: string) {
  const cleaned = content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/\s*```$/, "");

  const parsed: unknown = JSON.parse(cleaned);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Ranking response was not a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

async function callOpenRouter(
  prompt: string,
  model: string,
): Promise<{
  analysis: Record<string, unknown>;
  providerRequestId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}> {
  const apiKey = requiredEnvironmentValue("OPENROUTER_API_KEY");

  const response = await fetch(
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
        response_format: {
          type: "json_object",
        },
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(120000),
    },
  );

  if (!response.ok) {
    const responseBody = await response.text();

    console.error("OpenRouter ranking request failed:", {
      status: response.status,
      responseLength: responseBody.length,
    });

    throw new Error(`OpenRouter returned status ${response.status}.`);
  }

  const result = (await response.json()) as OpenRouterResult;

  const content = result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("OpenRouter returned an empty ranking response.");
  }

  return {
    analysis: parseGeneratedJson(content),
    providerRequestId: result.id ?? null,
    inputTokens: result.usage?.prompt_tokens ?? 0,
    outputTokens: result.usage?.completion_tokens ?? 0,
    costUsd: result.usage?.cost ?? 0,
  };
}

async function loadRankingContext(
  runId: string,
  userId: string | undefined,
): Promise<RankingContext> {
  const { data: run, error: runError } = await supabaseAdmin
    .from("ranking_runs")
    .select("id, candidate_profile_id")
    .eq("id", runId)
    .eq("user_id", userId)
    .single();

  if (runError) throw runError;

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("candidate_profiles")
    .select("id, cv_document_id, skills_profile, schema_hash, policy_version")
    .eq("id", run.candidate_profile_id)
    .eq("user_id", userId)
    .single();

  if (profileError) throw profileError;

  const { data: document, error: documentError } = await supabaseAdmin
    .from("candidate_documents")
    .select("extracted_text")
    .eq("id", profile.cv_document_id)
    .eq("user_id", userId)
    .single();

  if (documentError) throw documentError;

  if (!document.extracted_text?.trim()) {
    throw new Error("The active CV does not contain extracted text.");
  }

  await assertActiveCv(userId!, profile.cv_document_id);
  const { schemaText, schemaHash, policyVersion } = await loadCandidateSchema();
  if (profile.schema_hash !== schemaHash || profile.policy_version !== policyVersion) throw new Error("Candidate profile is no longer current.");
  const { classifier, model } = rankingConfiguration();

  return {
    runId,
    userId,
    candidateProfileId: profile.id,
    cvContent: document.extracted_text,
    skillsProfile: profile.skills_profile,
    schema: JSON.parse(schemaText),
    classifier,
    cvDocumentId: profile.cv_document_id,
    model,
  };
}

async function saveUsage(input: {
  context: RankingContext;
  result: Awaited<ReturnType<typeof callOpenRouter>>;
}) {
  const { error } = await supabaseAdmin.from("generation_usage").insert({
    user_id: input.context.userId,
    operation: "job_ranking",
    provider: "openrouter",
    model: input.context.model,
    input_tokens: input.result.inputTokens,
    output_tokens: input.result.outputTokens,
    provider_request_id: input.result.providerRequestId,
    cost_usd: input.result.costUsd,
    status: "succeeded",
  });

  if (error) {
    // Usage logging should be visible, but it should not
    // discard a successfully generated ranking.
    console.error("Could not save ranking usage:", error);
  }
}

async function rankOneJob(
  context: RankingContext,
  job: DatabaseJob,
): Promise<boolean> {
  const attemptedAt = new Date().toISOString();
  let resultSaved = false;

  const { error: processingError } = await supabaseAdmin.from("ranking_run_jobs")
    .update({ status: "processing", started_at: attemptedAt })
    .eq("ranking_run_id", context.runId).eq("job_id", job.id);
  if (processingError) throw processingError;

  try {
    const prompt = buildRankingPrompt({
      jobDescription: job.description,
      cvContent: context.cvContent,
      skillsProfile: context.skillsProfile,
      schema: context.schema,
    });

    await assertActiveCv(context.userId!, context.cvDocumentId);
    const typed = context.classifier === "jev" ? await rankWithJev({ description: job.description, cv: context.cvContent,
      profile: context.skillsProfile, schema: context.schema, model: context.model }) : null;
    const result = typed ? { analysis: typed.analysis, providerRequestId: null, inputTokens: 0, outputTokens: 0, costUsd: 0 } : await callOpenRouter(prompt, context.model);
    validateAnalysis(result.analysis, scoreProjection(context.skillsProfile));
    let requirements: Awaited<ReturnType<typeof assessRequiredRequirements>> | null = null;
    try {
      requirements = await assessRequiredRequirements({ posting: job.description, cv: context.cvContent });
    } catch (error) {
      // A failed companion review must be visible as unavailable, not an empty
      // list of requirements or a failed relevance rating.
      console.error("Could not review job must-haves:", {
        jobId: job.id,
        message: error instanceof Error ? error.message : "Requirement review failed.",
      });
    }
    (result.analysis as Record<string, unknown>).required_requirements = requirements?.requirements ?? null;
    await assertActiveCv(context.userId!, context.cvDocumentId);

    // A removal or changed description must not publish an obsolete analysis.
    const { data: association, error: associationError } = await supabaseAdmin
      .from("user_jobs").select("job_id,jobs(description)")
      .eq("user_id", context.userId).eq("job_id", job.id).maybeSingle();
    if (associationError) throw associationError;
    const currentJob = association?.jobs as unknown as { description: string } | null;
    if (!association || currentJob?.description !== job.description) {
      throw new Error("The saved job changed during ranking. Please retry.");
    }
    const score = calculateCandidateScore(result.analysis);

    const verifiedLocation = (result.analysis as Record<string, unknown>)["verified_location"];

    const locationMismatch = (result.analysis as Record<string, unknown>)["location_mismatch"];

    // Save the authoritative run result before updating the auxiliary latest-rating cache.
    const { error: resultError } = await supabaseAdmin.from("ranking_run_jobs")
      .update({
        status: "rated",
        completed_at: new Date().toISOString(),
        result_snapshot: {
          candidate_profile_id: context.candidateProfileId,
          job_input_identity: createHash("sha256").update(JSON.stringify({ description: job.description })).digest("hex"),
          job_id: job.id,
          analysis: result.analysis,
          prescriptive_score: score,
          ranking_version: rankingVersion,
          status: "rated",
          model: context.model,
          resolved_model: typed?.model ?? context.model,
          requirements_model: requirements?.model ?? null,
          classifier: context.classifier,
          rated_at: new Date().toISOString(),
          verified_location: verifiedLocation ?? null,
          location_mismatch: locationMismatch ?? false,
        },
      }).eq("ranking_run_id", context.runId).eq("job_id", job.id);
    if (resultError) throw resultError;
    resultSaved = true;

    const { error: saveError } = await supabaseAdmin
      .from("job_rankings")
      .upsert(
        {
          ranking_run_id: context.runId,
          user_id: context.userId,
          job_id: job.id,
          candidate_profile_id: context.candidateProfileId,
          prescriptive_score: score,
          analysis: result.analysis,
          verified_location:
            typeof verifiedLocation === "string" ? verifiedLocation : null,
          location_mismatch:
            typeof locationMismatch === "boolean" ? locationMismatch : false,
          status: "rated",
          ranking_version: rankingVersion,
          attempted_version: null,
          processing_error: null,
          attempted_at: attemptedAt,
          rated_at: new Date().toISOString(),
          model: context.model,
        },
        {
          onConflict: "user_id,job_id,candidate_profile_id,ranking_version",
        },
      );

    if (saveError) throw saveError;

    if (context.classifier === "llm") await saveUsage({ context, result });
    if (requirements) {
      await saveUsage({
        context: { ...context, model: requirements.model },
        result: {
          analysis: {},
          providerRequestId: requirements.providerRequestId,
          inputTokens: requirements.inputTokens,
          outputTokens: requirements.outputTokens,
          costUsd: requirements.costUsd,
        },
      });
    }

    return true;
  } catch (error) {
    // A complete result remains authoritative even when an auxiliary write loses its response.
    if (resultSaved) {
      console.error("Could not save auxiliary ranking data:", {
        runId: context.runId,
        jobId: job.id,
      });
      return true;
    }
    const publicMessage =
      error instanceof Error ? error.message : "Ranking failed.";

    console.error("Job ranking failed:", {
      runId: context.runId,
      jobId: job.id,
      error: publicMessage,
    });

    // Failed retries preserve the last valid rating. The run records its own failure.
    const { error: saveFailureError } = await supabaseAdmin.from("ranking_run_jobs")
      .update({ status: "failed", error_message: publicMessage, completed_at: new Date().toISOString(),
        result_snapshot: { job_id: job.id, status: "failed", processing_error: publicMessage } })
      .eq("ranking_run_id", context.runId).eq("job_id", job.id);
    if (saveFailureError) throw saveFailureError;

    return false;
  }
}

/** Drain admitted work before reporting a persistence failure or a terminal run. */
async function processWithConcurrency<T>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<void>,
) {
  let nextIndex = 0;
  let firstFailure: unknown;

  /** Continue the shared queue after a failed item so no admitted work escapes the run. */
  async function worker() {
    // Observe all admitted tasks before surfacing the first persistence failure.
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      try {
        await handler(items[index]!);
      } catch (error) {
        firstFailure ??= error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstFailure) throw firstFailure;
}

/** Own one run until all job results are settled and final counters are stored. */
export async function processRankingRun(
  runId: string,
  userId: string | undefined,
  jobIds: string[],
) {
  // Intermediate progress is best effort; final publication waits for settled results.
  try {
    const { error: startError } = await supabaseAdmin
      .from("ranking_runs")
      .update({
        status: "processing",
        started_at: new Date().toISOString(),
        error_message: null,
      })
      .eq("id", runId)
      .eq("user_id", userId);

    if (startError) throw startError;

    const context = await loadRankingContext(runId, userId);

    const { data: jobs, error: jobsError } = await supabaseAdmin
      .from("jobs")
      .select(
        `
          id,
          title,
          description,
          location,
          provider_payload
        `,
      )
      .in("id", jobIds);

    if (jobsError) throw jobsError;

    if (!jobs || jobs.length !== jobIds.length) {
      throw new Error("One or more selected jobs could not be loaded.");
    }

    let completedJobs = 0;
    let failedJobs = 0;
    let progressWrite = Promise.resolve();

    const configuredConcurrency = Number.parseInt(
      process.env.RANKING_CONCURRENCY ?? "3",
      10,
    );

    const concurrency =
      Number.isFinite(configuredConcurrency) && configuredConcurrency > 0
        ? Math.min(configuredConcurrency, 10)
        : 3;

    await processWithConcurrency(
      jobs as DatabaseJob[],
      concurrency,
      /** Publish settled per-job counts in order without abandoning other workers. */
      async (job) => {
        const succeeded = await rankOneJob(context, job);

        if (succeeded) {
          completedJobs++;
        } else {
          failedJobs++;
        }

        progressWrite = progressWrite.then(async () => {
          // Progress failures must not detach the workers from their parent run.
          const { error } = await supabaseAdmin.from("ranking_runs")
            .update({ processed_jobs: completedJobs + failedJobs, succeeded_jobs: completedJobs, failed_jobs: failedJobs })
            .eq("id", runId).eq("user_id", userId);
          if (error) throw error;
        }).catch(error => {
          console.error("Could not save ranking progress:", { runId, message: error instanceof Error ? error.message : "Database write failed." });
        });
        await progressWrite;
      },
    );

    const { error: completeError } = await supabaseAdmin
      .from("ranking_runs")
      .update({
        status: failedJobs === 0 ? "completed" : completedJobs > 0 ? "partially_completed" : "failed",
        processed_jobs: completedJobs + failedJobs,
            succeeded_jobs: completedJobs,
        failed_jobs: failedJobs,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("user_id", userId);

    if (completeError) throw completeError;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Ranking run failed.";

    console.error("Ranking run failed:", {
      runId,
      userId,
      error: message,
    });

    const { error: failureUpdateError } = await supabaseAdmin
      .from("ranking_runs")
      .update({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId)
      .eq("user_id", userId);

    if (failureUpdateError) {
      console.error(
        "Could not mark ranking run as failed:",
        failureUpdateError,
      );
    }
  }
}
