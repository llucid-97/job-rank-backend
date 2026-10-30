import { Router, type Request, type Response } from "express";
import { env } from "../../config/env.js";
import { consumeQuota } from "./provider-quota.js";
import { consumePublicFeedRequest } from "./public-feed-quota.js";
import { authenticate } from "../../middleware/authenticate.js";
import { requireActiveAccount } from "../../middleware/require-active-account.js";
import { AppError } from "../../middleware/error-handling.js";

export const providerRouter = Router();
providerRouter.use(["/jev", "/llm", "/feed"], authenticate, requireActiveAccount);

// This per-instance cap is a backstop, not a shared quota across serverless instances.
const requests = new Map<string, { start: number; count: number }>();
providerRouter.use(["/jev", "/llm", "/feed"], (request, _response, next) => {
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

providerRouter.get("/jev/health", (_request, response) => {
  response.json({ ok: true, service: "jobrank-jev-sidecar" });
});
providerRouter.post("/jev/rank", async (request, response) => {
  const body: unknown = request.body;
  if (!object(body) || !(typeof body.state === "string" || object(body.state) || Array.isArray(body.state)) || !object(body.questions)) invalid();
  const questions = Object.entries(body.questions);
  if (!questions.length || questions.length > 500 || questions.some(([id, question]) =>
    !id || id.length > 200 || !object(question) || !["choice", "score"].includes(String(question.type)) ||
    typeof question.instructions !== "string" || !question.instructions.trim() || question.instructions.length > 20_000 ||
    !(question.type === "score" ? Array.isArray(question.criteria) : object(question.criteria)) || Object.keys(question.criteria as object).length < 2 || Object.keys(question.criteria as object).length > 20 ||
    Object.values(question.criteria as object).some(value => typeof value !== "string" || !value.trim() || value.length > 5_000)
  )) invalid();
  await consumeQuota(request.auth!.userId, "jev", questions.length);
  try {
    const deadline = AbortSignal.timeout(60_000);
    let upstream: globalThis.Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      upstream = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST", redirect: "error", signal: deadline,
        headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state: body.state, questions: body.questions }),
      });
      if (![429, 529].includes(upstream.status) || attempt === 2) break;
      const retryAfter = upstream.headers.get("retry-after");
      const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Math.min(Number(retryAfter), 5) : null;
      await upstream.body?.cancel();
      await new Promise<void>((resolve, reject) => {
        if (deadline.aborted) return reject(new Error("Provider deadline exceeded."));
        const timer = setTimeout(() => { deadline.removeEventListener("abort", aborted); resolve(); }, seconds === null ? 500 * (2 ** attempt) : seconds * 1000);
        function aborted() { clearTimeout(timer); reject(new Error("Provider deadline exceeded.")); }
        deadline.addEventListener("abort", aborted, { once: true });
      });
    }
    if (!upstream) throw new Error("Provider request failed.");
    if (!upstream.ok) {
      response.status(upstream.status === 429 || upstream.status === 529 ? 429 : 502).json({ error: "TypeSafe request failed.", upstream_status: upstream.status });
      return;
    }
    const bytes = await readBounded(upstream, 2 * 1024 * 1024);
    response.type("application/json").send(bytes);
  } catch {
    throw new AppError(502, "PROVIDER_FAILED", "TypeSafe request failed.");
  }
});

providerRouter.post("/llm/generate", async (request, response) => {
  const body: unknown = request.body;
  if (!object(body) || typeof body.prompt !== "string" || !body.prompt.trim() || body.prompt.length > 200_000 ||
      (body.maxTokens !== undefined && (!Number.isInteger(body.maxTokens) || (body.maxTokens as number) < 1 || (body.maxTokens as number) > 4096)) ||
      (body.temperature !== undefined && (typeof body.temperature !== "number" || body.temperature < 0 || body.temperature > 1)) ||
      (body.workflow !== undefined && body.workflow !== "constraints" && body.workflow !== "candidateProfile") ||
      (body.responseFormat !== undefined && body.responseFormat !== "json_object")) invalid();
  await consumeQuota(request.auth!.userId, "llm", 1);
  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: body.workflow === "candidateProfile" ? env.SKILLS_JSON_GENERATION_MODEL : "openai/gpt-5.6-luna", messages: [{ role: "user", content: body.prompt }], max_tokens: body.maxTokens ?? 4096, temperature: body.temperature ?? 0, ...(body.responseFormat === "json_object" ? { response_format: { type: "json_object" } } : {}) }),
    });
    if (!upstream.ok) throw new Error("Provider failed.");
    const result = JSON.parse((await readBounded(upstream, 2 * 1024 * 1024)).toString("utf8"));
    const text = result?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("Empty provider response.");
    response.json({ data: { text } });
  } catch {
    throw new AppError(502, "PROVIDER_FAILED", "Language model request failed.");
  }
});

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
