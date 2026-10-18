import { rankingVersion } from "./ranking.configuration.js";
import { AppError } from "../../middleware/error-handling.js";
import { loadCandidateSchema } from "../candidate/candidate-profile.service.js";
import { supabaseAdmin } from "../../config/supabase.js";

export async function createRankingRun(
  userId: string | undefined,
  jobIds: string[],
) {
  /** Validate current candidate evidence and owned jobs before admitting a run. */
  const { data: activeCv, error: cvError } = await supabaseAdmin
    .from("candidate_documents")
    .select("id")
    .eq("user_id", userId)
    .eq("document_type", "cv")
    .eq("is_active", true)
    .maybeSingle();

  if (cvError) throw cvError;
  if (!activeCv) throw new AppError(409,"ACTIVE_CV_NOT_FOUND","Upload a CV before ranking jobs.");

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("candidate_profiles")
    .select("id, schema_hash, policy_version")
    .eq("user_id", userId)
    .eq("cv_document_id", activeCv.id)
    .eq("is_current", true)
    .maybeSingle();

  if (profileError) throw profileError;
  if (!profile) throw new AppError(409,"SKILLS_PROFILE_NOT_FOUND","Generate your skills profile before ranking jobs.");
  const schema = await loadCandidateSchema();
  if (profile.schema_hash !== schema.schemaHash || profile.policy_version !== schema.policyVersion) {
    throw new AppError(409,"STALE_SKILLS_PROFILE","Your profile needs to be regenerated before ranking jobs.");
  }

  // Users may only rank jobs associated with their account.
  const { data: userJobs, error: jobsError } = await supabaseAdmin
    .from("user_jobs")
    .select("job_id")
    .eq("user_id", userId)
    .in("job_id", jobIds);

  if (jobsError) throw jobsError;

  const allowedJobIds = userJobs.map((record) => record.job_id);

  if (allowedJobIds.length !== jobIds.length) {
    throw new AppError(403,"INVALID_JOB_SELECTION","Select jobs saved in your account.");
  }

  const { data: run, error: runError } = await supabaseAdmin
    .from("ranking_runs")
    .insert({
      user_id: userId,
      candidate_profile_id: profile.id,
      total_jobs: jobIds.length,
      ranking_version: rankingVersion,
    })
    .select()
    .single();

  if (runError) throw runError;

  const { error: membershipError } = await supabaseAdmin.from("ranking_run_jobs")
    .insert(allowedJobIds.map(jobId => ({ ranking_run_id: run.id, job_id: jobId })));
  if (membershipError) {
    await supabaseAdmin.from("ranking_runs").delete().eq("id", run.id).eq("user_id", userId);
    throw membershipError;
  }

  return {
    run,
    jobIds: allowedJobIds,
  };
}
