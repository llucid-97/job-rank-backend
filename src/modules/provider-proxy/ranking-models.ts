/** The server owns both the model allowlist and the reasoning budget. */
export const rankingModelIds = [
  "jev-latest",
  "baseten/elephant-1",
  "liquid/d1-ultra-20261015",
  "openai/gpt-6.1-sol",
  "openai/gpt-6-luna",
  "openai/gpt-6.1-terra",
] as const;

export type RankingModelId = (typeof rankingModelIds)[number];
export const rankingOptions = [
  { id: "jev-latest", label: "Jev", kind: "decision" },
  { id: "baseten/elephant-1", label: "Elephant 9B", kind: "decision" },
  { id: "liquid/d1-ultra-20261015", label: "d1-ultra", kind: "decision" },
  { id: "openai/gpt-6.1-sol", label: "GPT-6.1 Sol", kind: "llm", reasoningEffort: "low" },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", kind: "llm", reasoningEffort: "medium" },
  { id: "openai/gpt-6.1-terra", label: "GPT-6.1 Terra", kind: "llm", reasoningEffort: "low" },
] as const;

/** Old clients can name the historical Jev default without enabling arbitrary models. */
export function resolveRankingModel(value: unknown): RankingModelId | null {
  if (value === undefined || value === "jev-latest" || value === "typesafe/jev-1.13-20260917" || value === "jev-1.13.0") return "jev-latest";
  return typeof value === "string" && (rankingModelIds as readonly string[]).includes(value)
    ? value as RankingModelId : null;
}

/** Reject a provider's unrelated fallback while retaining its actual concrete model identity. */
export function matchesResolvedRankingModel(requested: RankingModelId, resolved: unknown): resolved is string {
  if (typeof resolved !== "string" || resolved.length > 200) return false;
  if (requested === "jev-latest") return /^(?:typesafe\/)?jev-(?:latest|\d+\.\d+\.\d+(?:-\d{8})?)$/.test(resolved);
  if (requested === "baseten/elephant-1") return /^baseten\/elephant-1(?:-\d{8})?$/.test(resolved);
  if (requested === "liquid/d1-ultra-20261015") return resolved === requested;
  return resolved === requested || new RegExp(`^${requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}(?:-?\\d{2}){1,2}$`).test(resolved);
}
