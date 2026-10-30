import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { AppError } from "../../middleware/error-handling.js";
import { supabaseAdmin } from "../../config/supabase.js";
import { providerPolicyFingerprint, constraintModel, jevModel } from "../provider-proxy/constraint-prompts.js";

const candidateId = z.string().regex(/^[0-9a-f]{64}$/);
const field = (characters: number, bytes: number) => z.string().min(1).max(characters)
  .refine(value => !value.includes("\0") && Buffer.byteLength(value, "utf8") <= bytes);
const pipelineVersion = field(200, 256);
const resolvedModel = field(200, 256).refine(value => !/(?:^|[-/])latest$/i.test(value), "A concrete model is required.");
const observation = z.object({
  source: field(100, 300),
  jobId: field(500, 1500),
  score: z.number().finite().min(0).max(1),
  ratedAt: z.iso.datetime({ offset: true }).refine(value => {
    const time = Date.parse(value);
    return Number.isFinite(time) && time >= 0 && time <= Date.now() + 5 * 60 * 1000;
  }, "Analysis time is invalid or too far in the future."),
});
const querySchema = z.object({ candidateId, pipelineVersion });
const upsertSchema = querySchema.extend({
  resolvedModel,
  scores: z.array(observation).min(1).max(5000),
});

/** Tell the client which hosted policy its next scores belong to. */
export function getMatchHistoryConfiguration(_request: Request, response: Response) {
  return response.json({ data: { policyFingerprint: providerPolicyFingerprint, jevModel, constraintModel } });
}

/** Store one observation per owner, candidate, pipeline, model and provider job. */
export async function putMatchHistory(request: Request, response: Response) {
  const input = upsertSchema.parse(request.body);
  const unique = new Set(input.scores.map(item => JSON.stringify([item.source, item.jobId])));
  if (unique.size !== input.scores.length) {
    throw new AppError(400, "DUPLICATE_MATCH_JOB", "A job can only appear once in a score update.");
  }
  const rows = input.scores.map(item => ({
    source: item.source,
    job_id: item.jobId,
    score: item.score,
    rated_at: item.ratedAt,
  }));
  const { error } = await supabaseAdmin.rpc("save_match_observations", {
    p_user_id: request.auth!.userId,
    p_candidate_id: input.candidateId,
    p_pipeline_version: input.pipelineVersion,
    p_resolved_model: input.resolvedModel,
    p_scores: rows,
  });
  if (error?.code === "P0001" && error.message === "MATCH_JOB_NOT_IN_WORKSPACE") {
    throw new AppError(400, "MATCH_JOB_NOT_IN_WORKSPACE", "Save every job in your workspace before recording its match score.");
  }
  if (error) throw error;
  return response.json({ data: { count: rows.length } });
}

/** Fetch every owner-scoped observation in the latest known resolved-model cohort. */
export async function getMatchHistory(request: Request, response: Response) {
  const input = querySchema.parse(request.query);
  const owner = request.auth!.userId;
  const base = () => supabaseAdmin.from("user_match_observations")
    .select("resolved_model,rated_at").eq("user_id", owner)
    .eq("candidate_id", input.candidateId).eq("pipeline_version", input.pipelineVersion);
  const { data: latest, error: latestError } = await base()
    .order("rated_at", { ascending: false }).limit(1).maybeSingle();
  if (latestError) throw latestError;
  if (!latest) return response.json({ data: { resolvedModel: null, scores: [] } });
  const model = latest.resolved_model;
  // Equal latest timestamps across models do not establish which model is current.
  const { data: competing, error: competingError } = await base()
    .eq("rated_at", latest.rated_at).neq("resolved_model", model).limit(1).maybeSingle();
  if (competingError) throw competingError;
  if (competing) return response.json({ data: { resolvedModel: null, scores: [] } });

  const rows: { id: number; source: string; job_id: string; score: number }[] = [];
  let after: number | undefined;
  // Stable-key pagination avoids losing rows when the service applies a smaller page cap.
  while (true) {
    let page = supabaseAdmin.from("user_match_observations")
      .select("id,source,job_id,score", { count: "exact" }).eq("user_id", owner)
      .eq("candidate_id", input.candidateId).eq("pipeline_version", input.pipelineVersion)
      .eq("resolved_model", model).order("id").limit(200);
    if (after !== undefined) page = page.gt("id", after);
    const { data, error, count } = await page;
    if (error) throw error;
    if (!data || count === null) throw new Error("Could not read the complete match history.");
    rows.push(...data);
    if (data.length >= count) break;
    if (!data.length) throw new Error("Match history changed during loading. Please retry.");
    const last = data.at(-1)!.id;
    if (!Number.isSafeInteger(last)) throw new Error("Invalid match history cursor.");
    after = last;
  }

  // A response may exceed the platform's non-streaming limit as history grows.
  function* json() {
    yield `{"data":{"resolvedModel":${JSON.stringify(model)},"scores":[`;
    for (const [index, row] of rows.entries()) {
      if (index) yield ",";
      yield JSON.stringify({ source: row.source, jobId: row.job_id, score: row.score });
    }
    yield "]}}";
  }
  response.type("application/json");
  await pipeline(Readable.from(json()), response);
}

/** Clear only the authenticated owner's historical scores, never shared postings. */
export async function deleteMatchHistory(request: Request, response: Response) {
  const { error } = await supabaseAdmin.from("user_match_observations")
    .delete().eq("user_id", request.auth!.userId);
  if (error) throw error;
  return response.json({ data: { cleared: true } });
}
