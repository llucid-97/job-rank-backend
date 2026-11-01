import type { NextFunction, Request, Response } from "express";
import { supabaseAuth } from "../config/supabase.js";
import { isExpiredCodexTestAccount } from "../modules/internal/codex-test-account-expiry.js";
import { AppError } from "./error-handling.js";

export async function authenticate(
  request: Request,
  _response: Response,
  next: NextFunction,
) {
  try {
    const authorization = request.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      throw new AppError(401, "UNAUTHENTICATED", "Authentication is required.");
    }

    const token = authorization.slice(7).trim();

    if (!token) {
      throw new AppError(
        401,
        "INVALID_ACCESS_TOKEN",
        "The access token is missing.",
      );
    }

    const {
      data: { user },
      error,
    } = await supabaseAuth.auth.getUser(token);

    if (error || !user) {
      throw new AppError(
        401,
        "INVALID_ACCESS_TOKEN",
        "Your session is invalid or has expired.",
      );
    }

    // Enforce the server-owned expiry claim on every protected route, even when
    // a browser continues sending a previously issued access token.
    if (isExpiredCodexTestAccount(user.app_metadata)) {
      throw new AppError(
        401,
        "TEST_ACCOUNT_EXPIRED",
        "This temporary test account has expired. Create a new test account to continue.",
      );
    }

    request.auth = {
      userId: user.id,
      email: user.email ?? null,
    };

    next();
  } catch (error) {
    next(error);
  }
}
