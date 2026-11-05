import { Router, type Request, type Response } from "express";
import { env } from "../../config/env.js";
import { consumeQuota } from "./provider-quota.js";
import { consumePublicFeedRequest } from "./public-feed-quota.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveAccount } from "../../middleware/require-active-account.js";
import { AppError } from "../../middleware/error-handling.js";
import { z } from "zod";
import { constraintModel, constraintOutputTokens, jevModel, jobConstraintMessages, searchConstraintMessages } from "./constraint-prompts.js";
import { boundedText } from "../jobs/search-state.schema.js";
import { matchesResolvedRankingModel, rankingOptions, resolveRankingModel } from "./ranking-models.js";
import { llmDecisionMessages, parseLlmDecision } from "./llm-decision.js";

export const providerRouter = Router();
providerRouter.use(["/jev", "/llm", "/feed"], authenticate, requireActiveAccount);

// This per-instance cap is a backstop, not a shared quota across serverless instances.
const requests = new Map<string, { start: number; count: number }>();
providerRouter.use(env.ALPHA_PREMIUM_ACCESS ? ["/feed"] : ["/jev", "/llm", "/feed"], (request, _response, next) => {
  const now = Date.now();
  for (const [key, value] of requests) if (now - value.start >= 60_000) requests.delete(key);
  const key = request.auth!.userId;
  const current = requests.get(key) ?? { start: now, count: 0 };
  if (++current.count > 300) return next(new AppError(429, "RATE_LIMITED", "Please try again shortly."));
  requests.set(key, current);
  next();
});

function invalid(): never {
  throw new AppError(400, "INVALID_REQUEST", "Invalid provider request.");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function readBounded(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("Empty provider response.");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) throw new Error("Provider response too large.");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts);
}

/** Preserve provider throttling without leaking upstream error bodies or credentials. */
function sendProviderFailure(response: Response, upstream: globalThis.Response) {
  const status = upstream.status;
  if (status === 429 || status === 529) {
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter && retryAfter.length <= 128 && (/^\d{1,10}$/.test(retryAfter) || Number.isFinite(Date.parse(retryAfter)))) {
      response.set("Retry-After", retryAfter);
    }
    response.status(429).json({ error: { code: "PROVIDER_RATE_LIMITED", message: "Ranking provider is busy. Please try again." } });
  } else if (status === 402) {
    response.status(402).json({ error: { code: "PROVIDER_CREDIT_EXHAUSTED", message: "The ranking provider has no available credit." } });
  } else {
    response.status(502).json({ error: { code: "PROVIDER_FAILED", message: "Ranking provider request failed." } });
  }
  void upstream.body?.cancel().catch(() => {});
}

/** Log only bounded model IDs and provider-reported token counts; never log prompts or answers. */
function recordRankingUsage(userId: string, requestedModel: string, result: unknown, questions: number) {
  if (!object(result)) return;
  const resolvedModel = typeof result.model === "string" && /^[A-Za-z0-9._:/-]{1,200}$/.test(result.model) ? result.model : null;
  const usage = object(result.usage) ? result.usage : {};
  const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000 ? value : null;
  console.info(JSON.stringify({ event: "ranking.provider.usage", userId, requestedModel, resolvedModel, questions,
    inputTokens: count(usage.prompt_tokens ?? usage.input_tokens), outputTokens: count(usage.completion_tokens ?? usage.output_tokens), totalTokens: count(usage.total_tokens) }));
}

providerRouter.get("/jev/health", (_request, response) => {
  response.json({ ok: true, service: "jobrank-jev-sidecar" });
});
export async function rankCategorical(request: Request, response: Response) {
  const body: unknown = request.body;
  if (!object(body) || !(typeof body.state === "string" || object(body.state) || Array.isArray(body.state)) || !object(body.questions)) invalid();
  const questions = Object.entries(body.questions);
  if (!questions.length || questions.length > 500 || questions.some(([id, question]) =>
    !id || id.length > 200 || !object(question) || !["choice", "score"].includes(String(question.type)) ||
    typeof question.instructions !== "string" || !question.instructions.trim() || question.instructions.length > 20_000 ||
    !(question.type === "score" ? Array.isArray(question.criteria) : object(question.criteria)) || Object.keys(question.criteria as object).length < 2 || Object.keys(question.criteria as object).length > 20 ||
    Object.values(question.criteria as object).some(value => typeof value !== "string" || !value.trim() || value.length > 5_000)
  )) invalid();
  const selected = resolveRankingModel(body.model);
  if (!selected) invalid();
  const option = rankingOptions.find(item => item.id === selected)!;
  await consumeQuota(request.auth!.userId, option.kind === "llm" ? "llm" : "jev", option.kind === "llm" ? 1 : questions.length);
  try {
    const deadline = AbortSignal.timeout(60_000);
    const direct = selected === "jev-latest";
    const chat = option.kind === "llm";
    const url = direct ? "https://api.typesafe.ai/v1/systemone" : chat
      ? "https://openrouter.ai/api/v1/chat/completions" : "https://openrouter.ai/api/alpha/decisions";
    const key = direct ? env.TYPESAFE_API_KEY : env.OPENROUTER_API_KEY;
    const payload = chat
      ? { model: selected, messages: llmDecisionMessages(body.state, body.questions), max_tokens: 4096,
          reasoning: { effort: "reasoningEffort" in option ? option.reasoningEffort : "low" },
          provider: { require_parameters: true } }
      : { model: selected, state: body.state, questions: body.questions };
    // The client handles throttling so retries do not multiply across layers.
    const upstream = await fetch(url, {
      method: "POST", redirect: "error", signal: deadline,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!upstream.ok) {
      sendProviderFailure(response, upstream);
      return;
    }
    const bytes = await readBounded(upstream, 2 * 1024 * 1024);
    const result: unknown = JSON.parse(bytes.toString("utf8"));
    recordRankingUsage(request.auth!.userId, selected, result, questions.length);
    if (!object(result) || !matchesResolvedRankingModel(selected, result.model)) throw new Error("Unexpected provider model.");
    // Decision responses already have the established model/answers shape; LLM text needs strict extraction.
    if (!chat) {
      response.type("application/json").send(bytes);
      return;
    }
    if (!object(result) || typeof result.model !== "string" || !result.model.trim() || !Array.isArray(result.choices)) throw new Error("Missing provider provenance.");
    const first = result.choices[0];
    if (!object(first) || !object(first.message) || typeof first.message.content !== "string") throw new Error("Missing provider answer.");
    response.json({ model: result.model, answers: parseLlmDecision(first.message.content, body.questions) });
  } catch {
    throw new AppError(502, "PROVIDER_FAILED", "Ranking provider request failed.");
  }
}
providerRouter.post("/jev/rank", rankCategorical);

// Structured inputs keep the server's extraction instructions separate from user data.
const searchInput = z.object({
  preferences: boundedText(2000, 16384),
  mustHaves: boundedText(2000, 16384),
}).strict().refine(value => value.preferences.trim() || value.mustHaves.trim());
const jobInput = z.object({
  posting: z.string().max(200000).refine(value => value.trim().length > 0 &&
    !value.includes("\0") && Buffer.byteLength(value, "utf8") <= 524288),
}).strict();

/** Validate the selected input contract before consuming quota or calling the provider. */
export async function generateLlm(request: Request, response: Response) {
  const body: unknown = request.body;
  if (!object(body) ||
      (body.maxTokens !== undefined && (!Number.isInteger(body.maxTokens) || (body.maxTokens as number) < 1 || (body.maxTokens as number) > constraintOutputTokens)) ||
      (body.temperature !== undefined && (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 1)) ||
      (body.workflow !== undefined && !["constraints", "candidateProfile", "searchConstraints", "jobConstraints"].includes(String(body.workflow))) ||
      (body.responseFormat !== undefined && body.responseFormat !== "json_object")) invalid();

  let messages: { role: string; content: string }[];
  if (body.workflow === "searchConstraints") {
    if (body.prompt !== undefined) invalid();
    const input = searchInput.parse(body.input);
    messages = searchConstraintMessages(input.preferences, input.mustHaves);
  } else if (body.workflow === "jobConstraints") {
    if (body.prompt !== undefined) invalid();
    messages = jobConstraintMessages(jobInput.parse(body.input).posting);
  } else {
    // Old clients send a full prompt; the new structured workflows cap each user field separately.
    const limit = 200000;
    if (typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > limit) invalid();
    messages = [{ role: "user", content: body.prompt }];
  }

  await consumeQuota(request.auth!.userId, "llm", 1);
  // Do not send user-chosen models or an unbounded response budget upstream.
  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: body.workflow === "candidateProfile" ? env.SKILLS_JSON_GENERATION_MODEL : constraintModel, messages, max_tokens: body.maxTokens ?? constraintOutputTokens, temperature: body.temperature ?? 0, ...(body.responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {}) }),
    });
    if (!upstream.ok) {
      sendProviderFailure(response, upstream);
      return;
    }
    const result = JSON.parse((await readBounded(upstream, 2 * 1024 * 1024)).toString("utf8"));
    const text = result?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("Empty provider response.");
    response.json({ data: { text } });
  } catch {
    throw new AppError(502, "PROVIDER_FAILED", "Language model request failed.");
  }
}

providerRouter.post("/llm/generate", generateLlm);

export function allowedFeed(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return false;
  const params = url.searchParams;
  if ([...params.keys()].some(key => params.getAll(key).length !== 1)) return false;
  const fields = (...allowed: string[]) => [...params.keys()].every(key => allowed.includes(key));
  const number = (key: string, min: number, max: number) => {
    const value = params.get(key);
    return value !== null && /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
  };
  const text = (key: string) => (params.get(key)?.length ?? 0) <= 1024;
  switch (url.hostname) {
    case "boards-api.greenhouse.io": return /^\/v1\/boards\/[A-Za-z0-9_-]+\/jobs$/.test(url.pathname) && fields("content") && params.get("content") === "true";
    case "api.ashbyhq.com": return /^\/posting-api\/job-board\/[A-Za-z0-9_-]+$/.test(url.pathname) && fields("includeCompensation") && params.get("includeCompensation") === "true";
    case "api.lever.co": case "api.eu.lever.co": return /^\/v0\/postings\/[A-Za-z0-9_-]+$/.test(url.pathname) && fields("mode", "skip", "limit") && params.get("mode") === "json" && number("skip", 0, 900) && number("limit", 1, 100);
    case "jobicy.com": return url.pathname === "/api/v2/remote-jobs" && fields("count", "tag") && number("count", 1, 200) && text("tag");
    case "weworkremotely.com": return url.pathname === "/remote-jobs.rss" && fields();
    case "remoteok.com": return url.pathname === "/api" && fields();
    case "www.myjobmag.com": case "www.myjobmag.co.ke": case "www.myjobmag.co.za": case "www.myjobmagghana.com": return url.pathname === "/jobsxml_by_categories.xml" && fields();
    case "jobsinnigeria.careers": return url.pathname === "/feed/" && fields();
    case "himalayas.app": return url.pathname === "/jobs/api/search" && fields("worldwide", "sort", "page", "q") && params.get("worldwide") === "true" && params.get("sort") === "recent" && number("page", 1, 10) && text("q");
    default: return false;
  }
}
export async function proxyPublicFeed(request: Request, response: Response) {
  if (Object.keys(request.query).length !== 1 || typeof request.query.url !== "string" || !allowedFeed(request.query.url)) invalid();
  const retryAfter = await consumePublicFeedRequest(request.auth!.userId);
  if (retryAfter > 0) {
    response.set("Retry-After", String(retryAfter));
    return response.status(429).json({
      error: {
        code: "FEED_RATE_LIMITED",
        message: "Please try again shortly.",
      },
    });
  }
  try {
    const upstream = await fetch(request.query.url, {
      redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Accept: "application/json, application/rss+xml, application/xml", "User-Agent": "JobRank/1.0 (+https://github.com/llucid-97/jobrank-v3)" },
    });
    if (!upstream.ok) throw new Error("Feed unavailable.");
    const bytes = await readBounded(upstream, 4 * 1024 * 1024);
    response.set("Content-Type", upstream.headers.get("content-type") ?? "application/octet-stream").set("Cache-Control", "no-store").send(bytes);
  } catch {
    throw new AppError(502, "FEED_UNAVAILABLE", "Job feed unavailable.");
  }
}

providerRouter.get("/feed", proxyPublicFeed);
