export const rankingVersion = "0.0.24";

/** Public ranking policy, with provider secrets retained on the server. */
export function rankingConfiguration(): { classifier: "jev" | "llm"; model: string; version: string } {
  const classifier = process.env.JOBRANK_CLASSIFIER?.trim() || "jev";
  if (classifier !== "jev" && classifier !== "llm") throw new Error("Unsupported backend ranking classifier.");
  const model = classifier === "jev" ? process.env.JEV_MODEL?.trim() || "jev-latest"
    : process.env.JOBRANK_RANKING_MODEL?.trim() || "openai/gpt-5.6-luna";
  return { classifier, model, version: rankingVersion };
}
