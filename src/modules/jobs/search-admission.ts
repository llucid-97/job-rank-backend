import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";

/** Claim a deployment-wide and per-user JobsDB search slot before charging quota. */
export async function acquireJobsDbSearchLease(userId: string, requestId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("acquire_jobsdb_search_lease", {
    p_user_id: userId,
    p_request_id: requestId,
  });
  if (error || typeof data !== "boolean") {
    throw new AppError(503, "JOB_SEARCH_ADMISSION_UNAVAILABLE", "Unable to check job search capacity.");
  }
  return data;
}

/** Release a claimed slot; expired leases recover capacity after terminated invocations. */
export async function releaseJobsDbSearchLease(userId: string, requestId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("release_jobsdb_search_lease", {
    p_user_id: userId,
    p_request_id: requestId,
  });
  if (error || typeof data !== "boolean") {
    throw new AppError(503, "JOB_SEARCH_ADMISSION_UNAVAILABLE", "Unable to release job search capacity.");
  }
  return data;
}
