import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { supabaseAdmin } from "../src/config/supabase.js";
import { AppError } from "../src/middleware/error-handling.js";
import { generateLlm } from "../src/modules/provider-proxy/provider.routes.js";

const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFetch = globalThis.fetch;

afterEach(() => {
  supabaseAdmin.rpc = originalRpc as any;
  globalThis.fetch = originalFetch;
});

function request() {
  return {
    auth: { userId: "00000000-0000-0000-0000-000000000001" },
    body: { prompt: "Synthetic prompt", maxTokens: 12 },
  } as any;
}

function response() {
  return {
    body: undefined as any,
    statusCode: 200,
    json(body: any) { this.body = body; return this; },
  } as any;
}

test("LLM quota denial at the route prevents a paid OpenRouter call", async () => {
  const events: string[] = [];
  supabaseAdmin.rpc = (async (name: string, args: any) => {
    events.push(`${name}:${args.p_kind}:${args.p_units}:${args.p_limit}`);
    return { data: false, error: null };
  }) as any;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls++;
    return new Response(JSON.stringify({ choices: [{ message: { content: "answer" } }] }));
  }) as typeof fetch;

  await assert.rejects(
    generateLlm(request(), response()),
    error => error instanceof AppError && error.statusCode === 429 && error.code === "QUOTA_EXCEEDED",
  );
  assert.deepEqual(events, ["consume_provider_quota:llm:1:100"]);
  assert.equal(providerCalls, 0);
});

test("LLM quota accounting failure fails closed before provider work", async () => {
  supabaseAdmin.rpc = (async () => ({ data: null, error: new Error("synthetic quota RPC failure") })) as any;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls++;
    return new Response("{}");
  }) as typeof fetch;

  await assert.rejects(
    generateLlm(request(), response()),
    error => error instanceof AppError && error.statusCode === 503 && error.code === "QUOTA_UNAVAILABLE",
  );
  assert.equal(providerCalls, 0);
});

test("admitted LLM request charges before the mocked provider call", async () => {
  const events: string[] = [];
  supabaseAdmin.rpc = (async (name: string, args: any) => {
    events.push(`${name}:${args.p_kind}:${args.p_units}:${args.p_limit}`);
    return { data: true, error: null };
  }) as any;
  globalThis.fetch = (async () => {
    events.push("openrouter");
    return new Response(JSON.stringify({ choices: [{ message: { content: "synthetic answer" } }] }));
  }) as typeof fetch;

  const result = response();
  await generateLlm(request(), result);

  assert.deepEqual(events, ["consume_provider_quota:llm:1:100", "openrouter"]);
  assert.equal(result.body.data.text, "synthetic answer");
});
