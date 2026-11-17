// Audience: maintainers. Offline proxy path and query boundary contracts.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { supabaseAdmin } from "../src/config/supabase.js";
import { AppError } from "../src/middleware/error-handling.js";
import { proxyPublicFeed } from "../src/modules/provider-proxy/provider.routes.js";

const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFetch = globalThis.fetch;
const endpoint = (url: string) => `https://api.eu.lever.co${url}`;

afterEach(() => {
  supabaseAdmin.rpc = originalRpc as any;
  globalThis.fetch = originalFetch;
});

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

test("public-feed proxy accepts dotted Lever global and EU boards and rejects unsafe paths and query shapes", async t => {
  supabaseAdmin.rpc = (async () => ({ data: 0, error: null })) as any;
  const calls: string[] = [];
  globalThis.fetch = (async input => {
    calls.push(String(input));
    return new Response("[]", { headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const validUrls = ['api.lever.co', 'api.eu.lever.co'].map(host =>
    `https://${host}/v0/postings/wahed.com?mode=json&skip=0&limit=1`);
  // Both fixed regional hosts use the same single-segment board-name contract.
  for (const valid of validUrls) {
    const result = response();
    await proxyPublicFeed({
      auth: { userId: "00000000-0000-0000-0000-000000000001" },
      query: { url: valid },
    } as any, result);
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["content-type"], "application/json");
    assert.equal(result.body.toString(), "[]");
  }
  assert.deepEqual(calls, validUrls);

  for (const [label, url] of [
    ["empty dot segment", endpoint("/v0/postings/wahed..com?mode=json&skip=0&limit=1")],
    ["traversal", endpoint("/v0/postings/../evil?mode=json&skip=0&limit=1")],
    ["encoded separator", endpoint("/v0/postings/wahed%2Fcom?mode=json&skip=0&limit=1")],
    ["unknown host", "https://api.other.lever.co/v0/postings/wahed.com?mode=json&skip=0&limit=1"],
    ["duplicate query key", endpoint("/v0/postings/wahed.com?mode=json&mode=json&skip=0&limit=1")],
    ["extra query key", endpoint("/v0/postings/wahed.com?mode=json&skip=0&limit=1&url=https://example.invalid")],
  ] as const) {
    await t.test(label, async () => {
      await assert.rejects(
        proxyPublicFeed({
          auth: { userId: "00000000-0000-0000-0000-000000000001" },
          query: { url },
        } as any, response()),
        error => error instanceof AppError && error.code === "INVALID_REQUEST",
      );
    });
  }
  assert.deepEqual(calls, validUrls);
});
