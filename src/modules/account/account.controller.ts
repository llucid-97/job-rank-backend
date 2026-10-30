import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";
import { boundedText, searchStateSchema } from "../jobs/search-state.schema.js";

const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
});

const updatePreferencesSchema = z.object({
  sourceSettings: z.record(z.string(), z.unknown()).optional(),
  searchQuery: boundedText(200, 1600).optional(),
  searchState: searchStateSchema.nullable().optional(),
  sourceSite: z.string().min(1).optional(),
  locationMode: z.string().min(1).optional(),
  countryScope: z.string().optional(),
  hasSalary: z.boolean().optional(),
  city: z.string().nullable().optional(),
  showArchivedJobs: z.boolean().optional(),
  showHiddenJobs: z.boolean().optional(),
  sortBy: z.string().min(1).optional(),
  jobsFetchLimit: z
    .union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)])
    .optional(),
});

export async function getMe(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const userId = request.auth!.userId;

    const [profile, role, entitlement] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("display_name, avatar_url, created_at")
        .eq("id", userId)
        .single(),

      supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", userId)
        .single(),

      supabaseAdmin
        .from("user_entitlements")
        .select(
          "plan, account_status, monthly_request_limit, ai_cost_limit_usd, period_started_at, period_ends_at",
        )
        .eq("user_id", userId)
        .single(),
    ]);

    if (profile.error || role.error || entitlement.error) {
      throw new AppError(
        404,
        "ACCOUNT_NOT_FOUND",
        "The account information could not be found.",
      );
    }

    response.json({
      data: {
        id: userId,
        email: request.auth?.email,
        displayName: profile.data.display_name,
        avatarUrl: profile.data.avatar_url,
        role: role.data.role,
        plan: entitlement.data.plan,
        accountStatus: entitlement.data.account_status,
        monthlyRequestLimit: entitlement.data.monthly_request_limit,
        monthlySpendLimitUsd: entitlement.data.ai_cost_limit_usd,
        createdAt: profile.data.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function updateMe(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const input = updateProfileSchema.parse(request.body);
    const userId = request.auth!.userId;

    const { data, error } = await supabaseAdmin
      .from("profiles")
      .update({
        display_name: input.displayName,
      })
      .eq("id", userId)
      .select("display_name, avatar_url, updated_at")
      .single();

    if (error) throw error;

    response.json({
      data: {
        displayName: data.display_name,
        avatarUrl: data.avatar_url,
        updatedAt: data.updated_at,
      },
    });
  } catch (error) {
    next(error);
  }
}

export async function getPreferences(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const userId = request.auth!.userId;

    const { data, error } = await supabaseAdmin
      .from("user_preferences")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) {
      throw new AppError(
        404,
        "PREFERENCES_NOT_FOUND",
        "User preferences could not be found.",
      );
    }

    response.json({
      data: data ?? {
        source_site: "configured",
        location_mode: "all",
        country_scope: "global",
        jobs_fetch_limit: 50,
      },
    });
  } catch (error) {
    next(error);
  }
}

/** Save only supplied settings for the token owner; unrelated preferences remain intact. */
export async function updatePreferences(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  try {
    const input = updatePreferencesSchema.parse(request.body);
    const userId = request.auth!.userId;

    const updates = {
      ...(input.searchState !== undefined && {
        search_state: input.searchState,
      }),
      ...(input.sourceSettings !== undefined && {
        source_settings: input.sourceSettings,
      }),
      ...(input.searchQuery !== undefined && {
        search_query: input.searchQuery,
      }),
      ...(input.sourceSite !== undefined && {
        source_site: input.sourceSite,
      }),
      ...(input.locationMode !== undefined && {
        location_mode: input.locationMode,
      }),
      ...(input.countryScope !== undefined && {
        country_scope: input.countryScope,
      }),
      ...(input.hasSalary !== undefined && {
        has_salary: input.hasSalary,
      }),
      ...(input.city !== undefined && {
        city: input.city,
      }),
      ...(input.showArchivedJobs !== undefined && {
        show_archived_jobs: input.showArchivedJobs,
      }),
      ...(input.showHiddenJobs !== undefined && {
        show_hidden_jobs: input.showHiddenJobs,
      }),
      ...(input.sortBy !== undefined && {
        sort_by: input.sortBy,
      }),
      ...(input.jobsFetchLimit !== undefined && {
        jobs_fetch_limit: input.jobsFetchLimit,
      }),
    };

    if (Object.keys(updates).length === 0) {
      throw new AppError(
        400,
        "NO_CHANGES",
        "No preference changes were supplied.",
      );
    }

    const { data, error } = await supabaseAdmin
      .from("user_preferences")
      .upsert({ user_id: userId, ...updates }, { onConflict: "user_id" })
      .select()
      .single();

    if (error) throw error;

    response.json({ data });
  } catch (error) {
    next(error);
  }
}
