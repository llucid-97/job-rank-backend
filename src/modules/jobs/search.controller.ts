import type { Request, Response } from "express";
import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { boundedText } from "./search-state.schema.js";

const historySchema = z.object({
  searches: z.array(z.object({
    query: boundedText(200, 1600).transform(value => value.trim()).refine(value => value.length > 0),
    locationMode: z.enum(["remote", "on-site", "all"]),
    countryScope: z.string().max(100),
    hasSalary: z.boolean(),
    city: z.string().max(100).nullable(),
  })).max(40),
});

/** Only the token owner may read or replace this account's saved queries. */
export async function getSearchHistory(request: Request, response: Response) {
  const { data, error } = await supabaseAdmin.from("saved_searches").select("*")
    .eq("user_id", request.auth!.userId).order("last_used_at", { ascending: false }).limit(40);
  if (error) throw error;
  return response.json({ data });
}

export async function saveSearchHistory(request: Request, response: Response) {
  const input = historySchema.parse(request.body);
  const { error } = await supabaseAdmin.rpc("save_search_history", { p_user_id: request.auth!.userId, p_searches: input.searches });
  if (error) throw error;
  return response.json({ data: { count: input.searches.length } });
}
