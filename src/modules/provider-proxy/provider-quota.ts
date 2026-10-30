import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";

export async function consumeQuota(userId: string, kind: "jev" | "llm", units: number) {
  const { data, error } = await supabaseAdmin.rpc("consume_provider_quota", {
    p_user_id: userId, p_kind: kind, p_units: units, p_limit: kind === "jev" ? 2000 : 100,
  });
  if (error || typeof data !== "boolean") throw new AppError(503, "QUOTA_UNAVAILABLE", "Unable to check provider quota.");
  if (!data) throw new AppError(429, "QUOTA_EXCEEDED", "Monthly provider quota reached.");
}
