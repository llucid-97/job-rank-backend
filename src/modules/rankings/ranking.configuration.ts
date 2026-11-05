import { defaultRankingModel, rankingOptions } from "../provider-proxy/ranking-models.js";

export const rankingVersion = "0.0.23";

/** Public ranking policy, with provider secrets retained on the server. */
export function rankingConfiguration() {
  const classifier = process.env.JOBRANK_CLASSIFIER?.trim() || "jev";
  if (classifier !== "jev" && classifier !== "llm") throw new Error("Unsupported backend ranking classifier.");
  const model = classifier === "jev" ? process.env.JEV_MODEL?.trim() || "jev-latest"
    : process.env.JOBRANK_RANKING_MODEL?.trim() || "openai/gpt-5.6-luna";
  return { classifier: classifier as "jev" | "llm", model, version: rankingVersion, defaultModel: defaultRankingModel, options: rankingOptions };
}
