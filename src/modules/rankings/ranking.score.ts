function collectScores(value: unknown, scores: number[]): boolean {
  if (Array.isArray(value)) {
    if (value.length === 0) return false;

    return value.every((item) => collectScores(item, scores));
  }

  if (typeof value === "object" && value !== null) {
    const values = Object.values(value);

    if (values.length === 0) return true;

    return values.every((item) => collectScores(item, scores));
  }

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    return false;
  }

  scores.push(value);
  return true;
}

export function calculateCandidateScore(analysis: Record<string, any>) {
  const scoreTree = analysis.candidate_match?.skills_interests_schema;
  if (!scoreTree || typeof scoreTree !== "object" || Array.isArray(scoreTree)
    || !collectScores(scoreTree, [])) {
    throw new Error("Ranking response contains an invalid score tree.");
  }

  // Interest and compensation leaves remain in the analysis for explanation,
  // but neither is evidence of a candidate's skills or experience.
  const scores: number[] = [];
  collectScores({
    skills: scoreTree.skills ?? {},
    professional_background: scoreTree.professional_background ?? {},
  }, scores);

  if (scores.length === 0) return 0;

  const offset = 0.1;

  const logSum = scores.reduce(
    (sum, score) => sum + Math.log(score + offset),
    0,
  );

  const geometricMean = Math.exp(logSum / scores.length);
  const normalized = geometricMean - offset;

  return Math.min(1, Math.max(0, normalized));
}
