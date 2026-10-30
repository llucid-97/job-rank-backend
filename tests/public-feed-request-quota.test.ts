import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { supabaseAdmin } from "../src/config/supabase.js";
import { AppError } from "../src/middleware/error-handling.js";
import { proxyPublicFeed } from "../src/modules/provider-proxy/provider.routes.js";

const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFetch = globalThis.fetch;

afterEach(() => {
  supabaseAdmin.rpc = originalRpc as any;
  globalThis.fetch = originalFetch;
});

function request() {
  return {
    auth: { userId: "00000000-0000-0000-0000-000000000001" },
    query: { url: "https://remoteok.com/api" },
  } as any;
}

function response() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    set(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
    send(body: any) { this.body = body; return this; },
  } as any;
}

test("shared public-feed denial returns retryable 429 before the upstream fetch", async () => {
  const events: string[] = [];
  supabaseAdmin.rpc = (async (name: string, args: any) => {
    events.push(`${name}:${args.p_user_id}`);
    return { data: 37, error: null };
  }) as any;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls++;
    return new Response("[]");
  }) as typeof fetch;

  const result = response();
  await proxyPublicFeed(request(), result);

  assert.equal(result.statusCode, 429);
  assert.equal(result.headers["retry-after"], "37");
  assert.equal(result.body.error.code, "FEED_RATE_LIMITED");
  assert.deepEqual(events, ["consume_public_feed_request:00000000-0000-0000-0000-000000000001"]);
  assert.equal(providerCalls, 0);
});

test("invalid or non-allowlisted feed requests do not consume shared quota", async () => {
  let quotaCalls = 0;
  supabaseAdmin.rpc = (async () => {
    quotaCalls++;
    return { data: 0, error: null };
  }) as any;
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls++;
    return new Response("[]");
  }) as typeof fetch;

  await assert.rejects(
    proxyPublicFeed({ ...request(), query: { url: "https://example.invalid/feed" } }, response()),
    error => error instanceof AppError && error.code === "INVALID_REQUEST",
  );
  assert.equal(quotaCalls, 0);
  assert.equal(providerCalls, 0);
});

test("public-feed quota RPC failures and malformed values fail closed", async t => {
  for (const outcome of [
    { data: null, error: new Error("synthetic RPC failure") },
    { data: true, error: null },
    { data: -1, error: null },
  ]) {
    await t.test(JSON.stringify({ data: outcome.data, hasError: Boolean(outcome.error) }), async () => {
      supabaseAdmin.rpc = (async () => outcome) as any;
      let providerCalls = 0;
      globalThis.fetch = (async () => {
        providerCalls++;
        return new Response("[]");
      }) as typeof fetch;

      await assert.rejects(
        proxyPublicFeed(request(), response()),
        error => error instanceof AppError && error.code === "FEED_QUOTA_UNAVAILABLE" && error.statusCode === 503,
      );
      assert.equal(providerCalls, 0);
    });
  }
});

test("valid public-feed proxy requests consume the shared budget before fetching", async () => {
  const events: string[] = [];
  supabaseAdmin.rpc = (async (name: string) => {
    events.push(name);
    return { data: 0, error: null };
  }) as any;
  globalThis.fetch = (async (input: string | URL | Request) => {
    events.push(`fetch:${String(input)}`);
    return new Response("[]", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const result = response();
  await proxyPublicFeed(request(), result);

  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(result.body.toString(), "[]");
  assert.deepEqual(events, [
    "consume_public_feed_request",
    "fetch:https://remoteok.com/api",
  ]);
});
