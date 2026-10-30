import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { ownerJob } from "./owner-job.js";
import { rankingVersion } from "../rankings/ranking.configuration.js";
import { AppError } from "../../middleware/error-handling.js";
import { supabaseAdmin } from "../../config/supabase.js";

const optionalText = z.string().nullable().optional();
const optionalObject = z.record(z.string(), z.unknown()).nullable().optional();
const workspaceSchema = z.object({
  replace: z.boolean().default(true),
  refreshProviderContent: z.boolean().default(false),
  sourceSite: z.string().min(1).max(100),
  jobs: z.array(z.object({
    id: z.string().min(1).max(500),
    source: z.string().min(1).max(100),
    title: z.string().max(2000),
    companyName: z.string().max(2000),
    location: z.string().max(2000),
    description: z.string().max(200000),
    url: z.string().max(4000),
    applicationStatus: z.enum(["Not Applied", "Applied", "Interviewing", "Offer Received", "Rejected", "Archived"]),
    isHidden: z.boolean().default(false),
    time: optionalText,
    poster: optionalText,
    skills: z.array(z.string()).nullable().optional(),
    prescriptiveScore: z.number().nullable().optional(),
    generatedCoverLetter: optionalText,
    generatedFuqAnswers: optionalText,
    llmVerifiedLocation: optionalText,
    locationMismatch: z.boolean().nullable().optional(),
    otherData: optionalObject,
    apiDatePosted: optionalText,
    apiJobData: optionalObject,
    summaryJson: optionalObject,
    interviewsNeeded: optionalText,
    applicationNotes: optionalText,
  }).passthrough()).max(5000),
});

/** Replace owner annotations atomically; only an explicit fresh import may refresh shared postings. */
export async function saveWorkspace(request: Request, response: Response) {
  const input = workspaceSchema.parse(request.body);
  const keys = new Set(input.jobs.map(job => `${job.source}\0${job.id}`));
  if (keys.size !== input.jobs.length) throw new AppError(400, "DUPLICATE_WORKSPACE_JOB", "Duplicate workspace job IDs.");
  if (input.refreshProviderContent && input.replace) {
    throw new AppError(400, "INVALID_PROVIDER_REFRESH", "Provider refresh requires an import without workspace replacement.");
  }
  if (input.sourceSite !== "configured" && input.jobs.some(job => job.source !== input.sourceSite)) {
    return response.status(400).json({ error: { code: "INVALID_WORKSPACE_SOURCE", message: "Jobs must belong to the selected source." } });
  }
  const { data, error } = await supabaseAdmin.rpc("save_job_workspace", {
    p_user_id: request.auth!.userId,
    p_source: input.sourceSite,
    p_jobs: input.jobs.map(job => ({
      ...job,
      databaseStatus: job.applicationStatus.toLowerCase().replaceAll(" ", "_"),
    })),
    p_replace: input.replace,
    p_refresh_provider_content: input.refreshProviderContent,
  });
  if (error) throw error;
  return response.json({ data });
}

const pageSize = 200;

/** Follow stable keys and exact remaining counts, including REST caps below our requested limit. */
async function readPages<T>(read: (after: T | undefined) => PromiseLike<{ data: T[] | null; count: number | null; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  let after: T | undefined;
  // Keyset pages cannot skip a surviving row when an earlier row is deleted between requests.
  while (true) {
    const { data, count, error } = await read(after);
    if (error) throw error;
    if (!data || count === null) throw new Error("Could not read the complete cloud workspace.");
    rows.push(...data);
    if (data.length >= count) return rows;
    if (data.length === 0) throw new Error("The cloud workspace changed during loading. Please retry.");
    after = data.at(-1);
  }
}

/** Restore this owner's complete workspace and rated run results without depending on the auxiliary cache. */
export async function getWorkspace(request: Request, response: Response) {
  const owner = request.auth!.userId;
  const rows = await readPages<{ job_id: string; [key: string]: any }>(after => {
    const query = supabaseAdmin.from("user_jobs")
      .select("job_id,workspace_data,application_status,application_notes,interviews_needed,is_hidden,jobs(*)", { count: "exact" })
      .eq("user_id", owner).order("job_id").limit(pageSize);
    return after ? query.gt("job_id", after.job_id) : query;
  });
  const ratings = new Map<string, Record<string, unknown>[]>();
  // Join through the owning run; another account's result must never enter this workspace.
  for (let offset = 0; offset < rows.length; offset += pageSize) {
    const ids = rows.slice(offset, offset + pageSize).map(row => row.job_id);
    const snapshots = await readPages<{
      ranking_run_id: string;
      job_id: string;
      completed_at: string | null;
      result_snapshot: any;
    }>(after => {
      const query = supabaseAdmin.from("ranking_run_jobs")
        .select("ranking_run_id,job_id,completed_at,result_snapshot,ranking_runs!inner(user_id)", { count: "exact" })
        .eq("ranking_runs.user_id", owner).eq("status", "rated")
        .eq("result_snapshot->>ranking_version", rankingVersion)
        .in("job_id", ids).order("ranking_run_id").order("job_id").limit(pageSize);
      return after ? query.or(`ranking_run_id.gt.${after.ranking_run_id},and(ranking_run_id.eq.${after.ranking_run_id},job_id.gt.${after.job_id})`) : query;
    });
    snapshots.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "")
      || b.ranking_run_id.localeCompare(a.ranking_run_id));
    // Newest matching profile/input wins in the client; old valid results remain usable after a failed retry.
    for (const row of snapshots) {
      if (!row.result_snapshot) continue;
      const values = ratings.get(row.job_id) ?? [];
      values.push(row.result_snapshot);
      ratings.set(row.job_id, values);
    }
  }
  function* workspaceJson() {
    yield '{"data":[';
    for (const [index, row] of rows.entries()) {
      if (index) yield ",";
      yield JSON.stringify({ ...row, jobs: ownerJob(row.jobs, row.workspace_data), ranking_results: ratings.get(row.job_id) ?? [] });
    }
    yield "]}";
  }
  response.type("application/json");
  await pipeline(Readable.from(workspaceJson()), response);
}
