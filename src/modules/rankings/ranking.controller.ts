import type { Request, Response } from "express";
import { z } from "zod";
import { createRankingRun } from "./ranking.service.js";
import { processRankingRun } from "./ranking.worker.js";
import { supabaseAdmin } from "../../config/supabase.js";

export async function startRankingRun(request: Request, response: Response) {
  const jobIds = request.body?.jobIds;

  if (
    !Array.isArray(jobIds) ||
    jobIds.length === 0 ||
    jobIds.length > 100 ||
    !jobIds.every((id) => z.string().uuid().safeParse(id).success)
  ) {
    return response.status(400).json({
      error: {
        code: "INVALID_JOB_IDS",
        message: "Provide between 1 and 100 job IDs.",
      },
    });
  }

  const result = await createRankingRun(request.auth?.userId, [
    ...new Set(jobIds),
  ]);

  // Start processing after returning control to the request.
  void processRankingRun(result.run.id, request.auth?.userId, result.jobIds);

  return response.status(202).json({
    data: result.run,
  });
}

export async function getRankingRun(request: Request, response: Response) {
  const { data, error } = await supabaseAdmin
    .from("ranking_runs")
    .select(
      `
      id,
      status,
      total_jobs,
      processed_jobs,
      succeeded_jobs,
      failed_jobs,
      skipped_jobs,
      error_message,
      created_at,
      started_at,
      completed_at
    `,
    )
    .eq("id", request.params.runId)
    .eq("user_id", request.auth?.userId)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    return response.status(404).json({
      error: {
        code: "RANKING_RUN_NOT_FOUND",
        message: "Ranking run was not found.",
      },
    });
  }

  return response.status(200).json({ data });
}

export async function getRankingRunResults(
  request: Request,
  response: Response,
) {
  const { data: run, error: runError } = await supabaseAdmin.from("ranking_runs")
    .select("id").eq("id", request.params.runId).eq("user_id", request.auth!.userId).maybeSingle();
  if (runError) throw runError;
  if (!run) return response.status(404).json({ error: { code: "RANKING_RUN_NOT_FOUND", message: "Ranking run was not found." } });
  const { data, error } = await supabaseAdmin.from("ranking_run_jobs")
    .select("result_snapshot").eq("ranking_run_id", run.id);
  if (error) throw error;
  return response.json({ data: (data ?? []).map(item => item.result_snapshot).filter(Boolean) });
}
