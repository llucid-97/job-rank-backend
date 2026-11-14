import type { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../config/supabase.js";
import { AppError } from "./error-handling.js";

// Require a confirmed active entitlement; retry only the known transient clock rejection.
export async function requireActiveAccount(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  try {
    const userId = request.auth?.userId;

    if (!userId) {
      throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
    }

    let { data, error } = await supabaseAdmin
      .from("user_entitlements")
      .select("account_status")
      .eq("user_id", userId)
      .maybeSingle();

    // Older PostgREST releases can briefly reject newly issued JWTs due to clock skew.
    if (error?.code === "PGRST303" && error.message === "JWT issued at future") {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      ({ data, error } = await supabaseAdmin
        .from("user_entitlements")
        .select("account_status")
        .eq("user_id", userId)
        .maybeSingle());
    }

    if (error) {
      console.error("Entitlement query failed:", {
        code: error.code,
        message: error.message,
      });

      throw new AppError(
        500,
        "ENTITLEMENT_QUERY_FAILED",
        "Unable to verify the account entitlement.",
      );
    }

    if (!data) {
      throw new AppError(
        403,
        "ENTITLEMENT_NOT_FOUND",
        "No account entitlement was found.",
      );
    }

    if (data.account_status !== "active") {
      throw new AppError(
        403,
        "ACCOUNT_SUSPENDED",
        "This account has been suspended.",
      );
    }

    next();
  } catch (error) {
    next(error);
  }
}
