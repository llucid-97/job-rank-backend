import { supabaseAdmin } from "../../config/supabase.js";
import { env } from "../../config/env.js";
import { AppError } from "../../middleware/error-handling.js";

export async function consumeQuota(userId: string, kind: "jev" | "llm" | "jobsdb", units: number) {
  // Only server deployment config can select the alpha recorder; user input cannot bypass quota.
  const rpcName = env.ALPHA_PREMIUM_ACCESS
    ? "record_alpha_provider_usage"
    : "consume_provider_quota";
  // The shared RPC also charges one monthly entitlement request per admitted
  // paid-provider operation; alpha mode records the same usage without limits.
  const args = env.ALPHA_PREMIUM_ACCESS
    ? { p_user_id: userId, p_kind: kind, p_units: units }
    : {
      p_user_id: userId,
      p_kind: kind,
      p_units: units,
      p_limit: kind === "jev" ? 2000 : kind === "jobsdb" ? 500 : 100,
    };
  const { data, error } = await supabaseAdmin.rpc(rpcName, args);
  if (error || typeof data !== "boolean") throw new AppError(503, "QUOTA_UNAVAILABLE", "Unable to check provider quota.");
  if (!data) throw new AppError(429, "QUOTA_EXCEEDED", "Monthly provider quota reached.");
}
