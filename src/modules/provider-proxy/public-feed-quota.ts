import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";

/** Consume one shared public-feed proxy request before making the upstream call. */
export async function consumePublicFeedRequest(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("consume_public_feed_request", {
    p_user_id: userId,
  });
  if (error || typeof data !== "number" || !Number.isInteger(data) || data < 0) {
    throw new AppError(503, "FEED_QUOTA_UNAVAILABLE", "Unable to check public feed capacity.");
  }
  return data;
}
