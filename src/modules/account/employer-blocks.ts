import { z } from "zod";
import { supabaseAdmin } from "../../config/supabase.js";
import { AppError } from "../../middleware/error-handling.js";

const name = z.string().trim().min(1).max(200).refine(value => normalizeEmployer(value).length > 0);
const reason = z.string().trim().min(1).max(1000);
export const employerBlocksSchema = z.object({
  version: z.literal(1),
  companies: z.array(z.object({ canonicalName: name, aliases: z.array(name).max(30), reason: reason.optional() }).strict()).max(500),
  roleExceptions: z.array(z.object({ url: z.string().url().max(2048), companies: z.array(name).min(1).max(30), reason: reason.optional() }).strict()).max(500),
  defaultReason: reason.optional(),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value), "utf8") <= 262144);
export type EmployerBlocks = z.infer<typeof employerBlocksSchema>;
export const emptyEmployerBlocks: EmployerBlocks = { version: 1, companies: [], roleExceptions: [] };
export const jobContextSchema = z.object({ companyName: z.string().max(200).nullable(), url: z.string().max(2048).nullable() }).strict();
export type JobContext = z.infer<typeof jobContextSchema>;
export function normalizeEmployer(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }

/** Keep unknown employers distinct from a confirmed non-match. */
export function employerDecision(policy: EmployerBlocks, context: JobContext) {
  const company = normalizeEmployer(context.companyName ?? "");
  if (!company) return { status: "unknown" as const };
  if (policy.roleExceptions.some(entry => entry.url === context.url && entry.companies.some(name => normalizeEmployer(name) === company))) return { status: "allowed" as const };
  const block = policy.companies.find(entry => [entry.canonicalName, ...entry.aliases].some(name => normalizeEmployer(name) === company));
  return block ? { status: "blocked" as const, canonicalName: block.canonicalName, reason: block.reason ?? policy.defaultReason ?? "Blocked at the user's request." } : { status: "allowed" as const };
}

/** Fail closed if the stored policy cannot be read or validated. */
export async function loadEmployerBlocks(userId: string): Promise<EmployerBlocks> {
  const { data, error } = await supabaseAdmin.from("user_preferences").select("employer_blocks").eq("user_id", userId).maybeSingle();
  if (error) throw new AppError(503, "EMPLOYER_POLICY_UNAVAILABLE", "Employer preferences could not be read.");
  const parsed = employerBlocksSchema.safeParse(data?.employer_blocks ?? emptyEmployerBlocks);
  if (!parsed.success) throw new AppError(503, "EMPLOYER_POLICY_UNAVAILABLE", "Employer preferences could not be read.");
  return parsed.data;
}

/** Re-read at dispatch so edits affect future paid work, including retries. */
export async function checkJobPolicy(userId: string, rawContext: unknown) {
  const policy = await loadEmployerBlocks(userId);
  if (rawContext === undefined && policy.companies.length === 0) return;
  const parsed = jobContextSchema.safeParse(rawContext);
  if (!parsed.success) throw new AppError(400, "JOB_CONTEXT_REQUIRED", "Provide the employer and URL for this job.");
  const decision = employerDecision(policy, parsed.data);
  if (decision.status === "blocked") throw new AppError(409, "EMPLOYER_BLOCKED", "This employer is blocked in your preferences.", { canonicalName: decision.canonicalName, reason: decision.reason });
}
