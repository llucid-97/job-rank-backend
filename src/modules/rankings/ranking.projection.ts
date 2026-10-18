/** Mirror the Flutter profile projection: skill details collapse, arrays use item keys. */
export function scoreProjection(profile: any): Record<string, any> {
  function project(value: any): any {
    if (Array.isArray(value)) {
      if (!value.every(item => typeof item === "string")) throw new Error("Profile arrays must contain strings.");
      return Object.fromEntries(value.map(item => [item, true]));
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, project(child)]));
    if (["string", "number", "boolean"].includes(typeof value)) return true;
    throw new Error("Invalid candidate profile value.");
  }
  const skills = project(profile.skills_interests_schema ?? {});
  if (profile.skills_interests_schema?.skills) {
    skills.skills = Object.fromEntries(Object.entries(profile.skills_interests_schema.skills).map(([category, values]) => [category,
      Object.fromEntries(Object.keys(values as object).map(name => [name, true]))]));
  }
  return { skills_interests_schema: skills, behavioral_points_schema: project(profile.behavioral_points_schema ?? {}) };
}

const explanationStopWords = new Set([
  "about", "after", "also", "and", "are", "been", "being", "both", "based", "can", "candidate", "could", "does",
  "each", "from", "have", "into", "its", "job", "just", "more", "most", "only", "other", "our", "profile",
  "role", "some", "such", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this",
  "those", "through", "very", "was", "were", "what", "when", "where", "which", "while", "with", "work",
  "would", "your", "skills", "interests", "schema", "behavioral", "points", "preferences", "professional",
  "background", "compensation", "aspirations", "traits", "areas", "experience", "education", "senior", "clinical",
  "team", "product", "systems", "system", "engineer", "engineering", "therapist", "therapy", "health", "healthcare",
  "seniority", "employment", "history",
  "company", "business", "support", "solutions", "services", "service", "global", "leading", "strong", "excellent",
  "ability", "skills", "knowledge", "related", "including", "required", "preferred", "multiple", "various", "across",
]);

function profileTerms(value: string, path: string[]): string[] {
  const candidates = [...path.slice().reverse().flatMap(part => part.split(/[^\p{L}\p{N}+#.]+/u)),
    ...value.split(/[^\p{L}\p{N}+#.]+/u)];
  const seen = new Set<string>();
  return candidates.filter(term => {
    const key = term.toLocaleLowerCase();
    if ([...term].length < 4 || /^\d+$/.test(term) || explanationStopWords.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Small inflection fold for one-word skill labels; excerpts still use the exact source word. */
function skillRoot(word: string): string {
  const lower = word.toLocaleLowerCase();
  if (lower.length > 6 && lower.endsWith("ing")) return lower.slice(0, -3);
  if (lower.length > 5 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.length > 5 && lower.endsWith("es")) return lower.slice(0, -2);
  if (lower.length > 5 && lower.endsWith("s")) return lower.slice(0, -1);
  return lower;
}

function termPattern(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
}

function excerptForTerms(source: string, terms: string[]): string | null {
  const spans: Array<[number, number]> = [];
  for (const term of terms) {
    const match = termPattern(term).exec(source);
    if (!match || match.index === undefined) return null;
    spans.push([match.index, match.index + match[0].length]);
  }
  const start = Math.min(...spans.map(span => span[0]));
  const end = Math.max(...spans.map(span => span[1]));
  if (end - start > 180) return null;

  const before = source.slice(0, start);
  const after = source.slice(end);
  const priorBoundary = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n"));
  const nextBoundaries = [after.indexOf("."), after.indexOf("!"), after.indexOf("?"), after.indexOf("\n")].filter(index => index >= 0);
  let left = priorBoundary >= 0 ? priorBoundary + 1 : Math.max(0, start - 70);
  let right = nextBoundaries.length ? end + Math.min(...nextBoundaries) + 1 : Math.min(source.length, end + 70);
  while (left < start && /\s/.test(source.charAt(left))) left++;
  while (right > end && /\s/.test(source.charAt(right - 1))) right--;
  if (right - left > 180) {
    left = Math.max(0, start - 70);
    right = Math.min(source.length, end + 70);
    while (left < start && !/\s/.test(source.charAt(left - 1))) left++;
    while (right > end && !/\s/.test(source.charAt(right))) right--;
  }
  if (right - left > 180) return null;
  const excerpt = source.slice(left, right).trim();
  return excerpt && terms.every(term => termPattern(term).test(excerpt)) ? excerpt : null;
}

/** Build only literal profile/CV/posting pairs. The quotes explain shared text, not requirements or score causes. */
function literalMatches(input: { description: string; cv: string; profile: any }, paths: string[][], scores: Record<string, any>) {
  const rows: Array<{ skill_or_requirement: string; reason: string; evidence: string; kind: "literal_overlap" }> = [];
  const seen = new Set<string>();
  const descriptionMarker = /\bDescription\s*:\s*/i.exec(input.description);
  const postingBody = descriptionMarker
    ? input.description.slice(descriptionMarker.index + descriptionMarker[0].length)
    : input.description;
  for (const path of paths) {
    if (path[0] !== "skills_interests_schema" || !["skills", "professional_background"].includes(path[1] || "")) continue;
    let value: any = input.profile;
    for (const key of path) value = Array.isArray(value) ? key : value?.[key] ?? key;
    const valueText = typeof value === "string" ? value : path.at(-1) || "";
    const labelPathStopWords = new Set(["skills_interests_schema", "behavioral_points_schema", "skills", "areas_of_interest",
      "professional_background", "compensation", "adaptability", "work_preferences", "personal_traits", "career_aspirations",
      "level", "years", "projects"]);
    const label = (path.slice().reverse().find(part => !labelPathStopWords.has(part))?.replace(/_/g, " ")
      || (valueText.trim().split(/\s+/).length <= 5 ? valueText.trim() : "Profile item")).slice(0, 80);
    const terms = profileTerms(valueText, path);
    const sharedTerms = terms.filter(term => termPattern(term).test(postingBody) && termPattern(term).test(input.cv));
    const requiredOverlap = terms.length >= 3 ? 2 : 1;
    if (sharedTerms.length < requiredOverlap) continue;
    const chosenTerms = sharedTerms.slice(0, Math.max(requiredOverlap, 2));
    const postingQuote = excerptForTerms(postingBody, chosenTerms);
    const evidence = excerptForTerms(input.cv, chosenTerms);
    if (!postingQuote || !evidence || !postingBody.includes(postingQuote) || !input.cv.includes(evidence)) continue;
    const reason = postingQuote;
    const identity = `${path.join("/")}\0${reason}\0${evidence}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push({ skill_or_requirement: label, reason, evidence, kind: "literal_overlap" });
    if (rows.length >= 4) break;
  }
  // A singular skill label can differ from the wording used in both source documents
  // (for example, Interviewing versus interviews). Keep the source word identical.
  const cvWordsByRoot = new Map<string, Set<string>>();
  for (const match of input.cv.matchAll(/[\p{L}]{8,}/gu)) {
    const word = match[0].toLocaleLowerCase();
    if (explanationStopWords.has(word)) continue;
    const root = skillRoot(word);
    cvWordsByRoot.set(root, (cvWordsByRoot.get(root) ?? new Set()).add(word));
  }
  for (const path of paths) {
    if (rows.length >= 4) break;
    if (path[0] !== "skills_interests_schema" || path[1] !== "skills") continue;
    const label = path.at(-1) || "";
    if (!/^[\p{L}]{5,}$/u.test(label) || explanationStopWords.has(label.toLocaleLowerCase())) continue;
    let score: any = scores;
    for (const key of path) score = score?.[key];
    if (typeof score !== "number" || score <= 0.5) continue;
    const words = cvWordsByRoot.get(skillRoot(label));
    if (!words) continue;
    for (const word of words) {
      if (!termPattern(word).test(postingBody)) continue;
      const reason = excerptForTerms(postingBody, [word]);
      const evidence = excerptForTerms(input.cv, [word]);
      if (!reason || !evidence) continue;
      const identity = `${path.join("/")}\0${reason}\0${evidence}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      rows.push({ skill_or_requirement: label, reason, evidence, kind: "literal_overlap" });
      break;
    }
  }
  // Profile extraction can omit a concrete skill that is still written in the CV.
  // Use only adjacent, specific words that appear verbatim in both source texts.
  const cvWords = [...input.cv.matchAll(/[\p{L}\p{N}]+/gu)];
  const phraseSeen = new Set<string>();
  let lastAddedIndex = -2;
  for (let index = 0; index + 1 < cvWords.length && index < 600 && rows.length < 4; index++) {
    if (index === lastAddedIndex + 1) continue;
    const first = cvWords[index]!;
    const second = cvWords[index + 1]!;
    if (!/^\s+$/.test(input.cv.slice(first.index! + first[0].length, second.index!))) continue;
    const terms = [first[0], second[0]];
    if (terms.some(term => (term.length < 4 && !["qa", "ux"].includes(term.toLowerCase()))
      || explanationStopWords.has(term.toLowerCase()))) continue;
    const phrase = terms.join(" ").toLowerCase();
    if (phraseSeen.has(phrase)) continue;
    phraseSeen.add(phrase);
    // Both terms must be adjacent in each source; nearby unrelated words are not a match.
    const adjacent = new RegExp(`(?<![\\p{L}\\p{N}])${terms.join("\\s+")}(?![\\p{L}\\p{N}])`, "iu");
    const postingOccurrence = adjacent.exec(postingBody);
    const cvOccurrence = adjacent.exec(input.cv);
    if (!postingOccurrence || !cvOccurrence) continue;
    const postingQuote = excerptForTerms(postingBody.slice(postingOccurrence.index), terms);
    const evidence = excerptForTerms(input.cv.slice(cvOccurrence.index), terms);
    if (!postingQuote || !evidence || !postingBody.includes(postingQuote) || !input.cv.includes(evidence)) continue;
    rows.push({ skill_or_requirement: first[0] + " " + second[0],
      reason: postingQuote, evidence, kind: "literal_overlap" });
    lastAddedIndex = index;
  }
  return rows;
}

/** Validate exact score paths before a provider result may become a stored rating. */
export function validateAnalysis(analysis: any, projection: Record<string, any>, sources?: { description: string; cv: string }) {
  function validate(value: any, shape: any): void {
    if (shape === true) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error("Invalid ranking score.");
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join("\0") !== Object.keys(shape).sort().join("\0")) throw new Error("Ranking score paths differ from the candidate profile.");
    for (const key of Object.keys(shape)) validate(value[key], shape[key]);
  }
  for (const root of Object.keys(projection)) validate(analysis?.candidate_match?.[root], projection[root]);
  const object = (value: any) => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!object(analysis?.job_summary)
    || !object(analysis.job_summary.skills_interests_schema)
    || !object(analysis.job_summary.behavioral_points_schema)
    || !Array.isArray(analysis?.candidate_match?.matches)) throw new Error("Incomplete ranking analysis.");
  for (const match of analysis.candidate_match.matches) {
    if (!object(match) || ["skill_or_requirement", "reason", "evidence"]
      .some(field => typeof match[field] !== "string" || !match[field].trim())) {
      throw new Error("Invalid ranking match evidence.");
    }
    if (match.kind !== undefined && match.kind !== "literal_overlap") throw new Error("Invalid ranking match kind.");
    if (match.kind === "literal_overlap" && sources
      && (match.reason.length > 180 || match.evidence.length > 180
        || !sources.description.includes(match.reason) || !sources.cv.includes(match.evidence))) {
      throw new Error("Ranking overlap excerpt does not match its source.");
    }
  }
}

/** Ask Jev one ordinal fit question for each candidate leaf, then normalize to [0,1]. */
export async function rankWithJev(input: { description: string; cv: string; profile: any; schema: unknown; model: string }) {
  const projection = scoreProjection(input.profile);
  const questions: Record<string, any> = {};
  const paths: string[][] = [];
  const criteria = ["Not related to this job.", "Tangentially related to this job.", "Strongly related to this job.", "A specific, direct match for this job."];
  /** Give each exact candidate leaf a stable question ID so answers map back to its score path. */
  function walk(shape: any, path: string[]) {
    if (shape !== true) {
      for (const key of Object.keys(shape)) walk(shape[key], [...path, key]);
      return;
    }
    let value: any = input.profile;
    for (const key of path) value = Array.isArray(value) ? key : value?.[key] ?? key;
    const id = `q${paths.length.toString().padStart(4, "0")}`;
    paths.push(path);
    questions[id] = { type: "score", instructions: `Rate how well the job fits the candidate profile item at exact path ${JSON.stringify(path)} with candidate value ${JSON.stringify(value)}. Use the job description to judge relevance and the candidate profile to understand the item. Rate match strength, not answer confidence. Do not infer that a profile item is a job requirement merely because the candidate has it.`, criteria };
  }
  walk(projection, []);
  if (paths.length === 0) {
    return { analysis: { job_summary: { skills_interests_schema: {}, behavioral_points_schema: {} },
      candidate_match: { ...projection, matches: [] } }, model: input.model };
  }
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new Error("TYPESAFE_API_KEY is not configured on the backend.");
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: input.model, state: { job_description: input.description, candidate_resume: input.cv, candidate_profile: input.profile, ranking_schema: input.schema }, questions }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Jev returned status ${response.status}.`);
  const result = await response.json() as any;
  if (!result.answers || Object.keys(result.answers).length !== paths.length || typeof result.model !== "string") throw new Error("Incomplete Jev response.");
  const trees = structuredClone(projection);
  paths.forEach((path, index) => {
    const answer = result.answers[`q${index.toString().padStart(4, "0")}`];
    if (answer?.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 3) throw new Error("Invalid Jev score.");
    let target = trees;
    for (const key of path.slice(0, -1)) target = target[key];
    target[path.at(-1)!] = answer.score / 3;
  });
  return { analysis: { job_summary: { skills_interests_schema: {}, behavioral_points_schema: {} },
    candidate_match: { ...trees, matches: literalMatches(input, paths, trees) } }, model: result.model };
}
