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
  "research", "monthly", "quarterly", "weekly", "daily", "annual", "yearly",
]);
/** Small inflection fold for one-word skill labels; excerpts still use the exact source word. */
function skillRoot(word: string): string {
  const lower = word.toLocaleLowerCase();
  if (lower.length > 6 && lower.endsWith("ing")) return lower.slice(0, -3);
  if (lower.length > 5 && lower.endsWith("ies")) return `${lower.slice(0, -3)}y`;
  if (lower.length > 5 && lower.endsWith("es")) return lower.slice(0, -2);
  if (lower.length > 5 && lower.endsWith("s")) return lower.slice(0, -1);
  return lower;
}

function excerptForSpan(source: string, start: number, end: number): string | null {
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
  return source.slice(left, right).trim() || null;
}

/** Select one exact work-history/posting excerpt pair per scored skill path, before semantic scoring. */
function scoredSkillCandidates(input: { description: string; cv: string; profile: any }, paths: string[][]) {
  const descriptionMarker = /\bDescription\s*:\s*/i.exec(input.description);
  const postingBody = descriptionMarker
    ? input.description.slice(descriptionMarker.index + descriptionMarker[0].length)
    : input.description;
  const background: string[] = [];
  function collect(value: any): void {
    if (typeof value === "string") background.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  }
  collect(input.profile?.skills_interests_schema?.professional_background);
  const sentences = (source: string) => source.split(/(?<=[!?])\s+|(?<=\.)\s+(?=[A-Z“])/u)
    .map(sentence => sentence.trim()).filter(Boolean);
  const cvSentences = background.flatMap(sentences);
  const postingSentences = sentences(postingBody);
  const requiredStart = /required\s+skills\s*(?:&|and)\s*experience/i.exec(postingBody)?.index ?? -1;
  const nextSection = requiredStart >= 0
    ? /\b(?:ideal\s+candidate|nice\s+to\s+have|preferred\s+qualifications|what\s+we\s+offer)\b/i.exec(postingBody.slice(requiredStart + 1))
    : null;
  const requiredEnd = nextSection ? requiredStart + 1 + nextSection.index : postingBody.length;
  const isRequiredSentence = (sentence: string) => {
    const index = postingBody.indexOf(sentence, Math.max(0, requiredStart));
    return requiredStart >= 0 && index >= requiredStart && index < requiredEnd;
  };
  const roots = (label: string) => [...new Set(label.split(/[^\p{L}\p{N}+#]+/u)
    .filter(word => [...word].length >= 5 && !explanationStopWords.has(word.toLocaleLowerCase()))
    .map(skillRoot))].sort((left, right) => right.length - left.length);
  const containsRoot = (sentence: string, root: string) => [...sentence.matchAll(/[\p{L}\p{N}]+/gu)]
    .some(match => skillRoot(match[0]) === root);
  const actionText = /\b(?:align|analy[sz]e|build|conduct|coordinate|create|deliver|design|develop|drive|establish|evaluate|implement|investigate|lead|maintain|manage|monitor|own|plan|prepare|reconcile|review|support|test|translate|troubleshoot|write)\b/i;
  const candidates: Array<{ match: { skill_or_requirement: string; reason: string; evidence: string; kind: "literal_overlap" }; scoreIndex: number }> = [];
  const seenSkills = new Set<string>();
  for (const [scoreIndex, path] of paths.entries()) {
    if (path[0] !== "skills_interests_schema" || path[1] !== "skills") continue;
    const label = (path.at(-1) || "").replace(/_/g, " ").trim();
    const normalized = label.toLocaleLowerCase().replace(/\s+/g, " ");
    if (!label || seenSkills.has(normalized)) continue;
    const anchor = roots(label).find(root => {
      const cvSentence = cvSentences.find(sentence => sentence.length <= 180 && containsRoot(sentence, root));
      const postingSentence = postingSentences.filter(sentence => sentence.length <= 180 && containsRoot(sentence, root))
        .sort((left, right) => Number(isRequiredSentence(right)) - Number(isRequiredSentence(left))
          || Number(actionText.test(right)) - Number(actionText.test(left)))[0];
      if (!cvSentence || !postingSentence) return false;
      if (!input.cv.includes(cvSentence) || !input.description.includes(postingSentence)) return false;
      candidates.push({ match: { skill_or_requirement: label, reason: postingSentence, evidence: cvSentence, kind: "literal_overlap" }, scoreIndex });
      return true;
    });
    if (anchor) seenSkills.add(normalized);
    if (candidates.length >= 8) break;
  }
  return candidates;
}
type ScoredSkillCandidate = ReturnType<typeof scoredSkillCandidates>[number];

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
    for (const field of ["posting_requirement_probability", "cv_evidence_probability"]) {
      if (match[field] !== undefined
        && (typeof match[field] !== "number" || !Number.isFinite(match[field]) || match[field] < 0 || match[field] > 1)) {
        throw new Error("Invalid ranking explanation probability.");
      }
    }
  }
}

/** Ask Jev for each profile score and validate a bounded set of exact-source explanations in the same request. */
export async function rankWithJev(input: { description: string; cv: string; profile: any; schema: unknown; model: string }) {
  const projection = scoreProjection(input.profile);
  const questions: Record<string, any> = {};
  const paths: string[][] = [];
  const profileItemText: Record<string, any> = Object.create(null);
  const criteria = ["Not related to this job.", "Tangentially related to this job.", "Strongly related to this job.", "A specific, direct match for this job."];
  /** Give each exact candidate leaf a stable question ID so answers map back to its score path. */
  function walk(shape: any, path: string[]) {
    if (shape !== true) {
      for (const key of Object.keys(shape)) walk(shape[key], [...path, key]);
      return;
    }
    let value: any = input.profile;
    for (const key of path) value = Array.isArray(value) ? key : value?.[key] ?? key;
    // Score keys can be shortened by profile extraction. Keep the original
    // profile wording for display without changing any score path or value.
    if (typeof value === "string" && value.trim() && value !== path.at(-1)) {
      let target = profileItemText;
      for (const key of path.slice(0, -1)) target = target[key] ??= Object.create(null);
      target[path.at(-1)!] = value;
    }
    const id = `q${paths.length.toString().padStart(4, "0")}`;
    paths.push(path);
    questions[id] = { type: "score", instructions: `Rate how well the job fits the candidate profile item at exact path ${JSON.stringify(path)} with candidate value ${JSON.stringify(value)}. Use the job description to judge relevance and the candidate profile to understand the item. Rate match strength, not answer confidence. Do not infer that a profile item is a job requirement merely because the candidate has it.`, criteria };
  }
  walk(projection, []);
  if (paths.length === 0) {
    return { analysis: { job_summary: { skills_interests_schema: {}, behavioral_points_schema: {} },
      candidate_match: { ...projection, matches: [] } }, model: input.model, semanticEvaluations: [] };
  }
  const candidateMatches = scoredSkillCandidates(input, paths);
  const semanticIds = candidateMatches.map((_, index) => ({
    posting: `m${index.toString().padStart(4, "0")}a`, evidence: `m${index.toString().padStart(4, "0")}b`,
  }));
  candidateMatches.forEach(({ match }, index) => {
    const ids = semanticIds[index]!;
    questions[ids.posting] = { type: "noul", instructions: `Does this exact job posting excerpt describe an actual responsibility or qualification, rather than a job title, SEO keyword list, company description, or benefits text? Use the surrounding job description for context. Excerpt: ${JSON.stringify(match.reason)}` };
    questions[ids.evidence] = { type: "noul", instructions: `Does this exact professional-background excerpt show the candidate performing the same work task or specific skill named in the job requirement? Judge the work itself; do not rely on a title, shared generic noun, aspiration, benefits, or adjacent domain. Candidate scored skill: ${JSON.stringify(match.skill_or_requirement)}. Job requirement excerpt: ${JSON.stringify(match.reason)}. Candidate work-history excerpt: ${JSON.stringify(match.evidence)}` };
  });
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) throw new Error("TYPESAFE_API_KEY is not configured on the backend.");
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: input.model, state: { job_description: input.description, candidate_resume: input.cv, candidate_profile: input.profile, ranking_schema: input.schema }, questions }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Jev returned status ${response.status}.`);
  const result = await response.json() as any;
  const expectedAnswerCount = paths.length + semanticIds.length * 2;
  if (!result.answers || Object.keys(result.answers).length !== expectedAnswerCount || typeof result.model !== "string") throw new Error("Incomplete Jev response.");
  const trees = structuredClone(projection);
  paths.forEach((path, index) => {
    const answer = result.answers[`q${index.toString().padStart(4, "0")}`];
    if (answer?.type !== "score" || typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 3) throw new Error("Invalid Jev score.");
    let target = trees;
    for (const key of path.slice(0, -1)) target = target[key];
    target[path.at(-1)!] = answer.score / 3;
  });
  const matches: Array<ScoredSkillCandidate["match"] & { posting_requirement_probability: number; cv_evidence_probability: number }> = [];
  const semanticEvaluations: Array<ScoredSkillCandidate["match"] & {
    candidate_score: number; posting_requirement_probability: number; cv_evidence_probability: number; supported: boolean;
  }> = [];
  const seenMatches = new Set<string>();
  candidateMatches.forEach(({ match, scoreIndex }, index) => {
    const ids = semanticIds[index]!;
    const postingAnswer = result.answers[ids.posting];
    const evidenceAnswer = result.answers[ids.evidence];
    if (postingAnswer?.type !== "noul" || typeof postingAnswer.noul !== "number" || !Number.isFinite(postingAnswer.noul)
      || postingAnswer.noul < 0 || postingAnswer.noul > 1
      || evidenceAnswer?.type !== "noul" || typeof evidenceAnswer.noul !== "number" || !Number.isFinite(evidenceAnswer.noul)
      || evidenceAnswer.noul < 0 || evidenceAnswer.noul > 1) throw new Error("Invalid Jev semantic answer.");
    const scorePath = paths[scoreIndex]!;
    let score: any = trees;
    for (const key of scorePath) score = score?.[key];
    const supported = score > 0.5 && postingAnswer.noul >= 0.5 && evidenceAnswer.noul > 0.55;
    semanticEvaluations.push({ ...match, candidate_score: score, posting_requirement_probability: postingAnswer.noul,
      cv_evidence_probability: evidenceAnswer.noul, supported });
    if (!supported) return;
    const identity = `${match.reason}\0${match.evidence}`;
    if (seenMatches.has(identity)) return;
    seenMatches.add(identity);
    matches.push({ ...match, posting_requirement_probability: postingAnswer.noul, cv_evidence_probability: evidenceAnswer.noul });
  });
  return { analysis: { job_summary: { skills_interests_schema: {}, behavioral_points_schema: {} },
    candidate_match: { ...trees, matches, profile_item_text: profileItemText } }, model: result.model, semanticEvaluations };
}
