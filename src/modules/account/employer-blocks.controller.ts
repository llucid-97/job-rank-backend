import type { Request, Response } from "express";
import { supabaseAdmin } from "../../config/supabase.js";
import { employerBlocksSchema, loadEmployerBlocks } from "./employer-blocks.js";

export async function getEmployerBlocks(request: Request, response: Response) {
  response.json({ data: await loadEmployerBlocks(request.auth!.userId) });
}

/** Write only this column so independent preference saves cannot erase the policy. */
export async function putEmployerBlocks(request: Request, response: Response) {
  const policy = employerBlocksSchema.parse(request.body);
  const { error } = await supabaseAdmin.from("user_preferences").upsert({ user_id: request.auth!.userId, employer_blocks: policy }, { onConflict: "user_id" });
  if (error) throw error;
  response.json({ data: policy });
}
