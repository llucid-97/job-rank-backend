import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";

export async function consumeQuota(userId: string, kind: "jev" | "llm" | "jobsdb", units: number) {
  // The shared RPC also charges one monthly entitlement request per admitted
  // paid-provider operation; `units` preserves the existing per-kind ceiling.
  const { data, error } = await supabaseAdmin.rpc("consume_provider_quota", {
    p_user_id: userId, p_kind: kind, p_units: units, p_limit: kind === "jev" ? 2000 : kind === "jobsdb" ? 500 : 100,
  });
  if (error || typeof data !== "boolean") throw new AppError(503, "QUOTA_UNAVAILABLE", "Unable to check provider quota.");
  if (!data) throw new AppError(429, "QUOTA_EXCEEDED", "Monthly provider quota reached.");
}
