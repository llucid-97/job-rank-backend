// Audience: maintainers. Keep entitlement verification fail-closed while recovering the known PostgREST clock error.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const { supabaseAdmin } = await import("../src/config/supabase.js");
const { requireActiveAccount } = await import("../src/middleware/require-active-account.js");
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalSetTimeout = globalThis.setTimeout;
afterEach(() => {
  supabaseAdmin.from = originalFrom as any;
  globalThis.setTimeout = originalSetTimeout;
});

function harness(results: any[]) {
  const owners: string[] = [];
  const builders: object[] = [];
  let calls = 0;
  supabaseAdmin.from = ((table: string) => {
    assert.equal(table, "user_entitlements");
    const builder = {
      select() { return this; },
      eq(_column: string, userId: string) { owners.push(userId); return this; },
      maybeSingle() { return Promise.resolve(results[calls++]); },
    };
    builders.push(builder);
    return builder as any;
  }) as any;
  const errors: any[] = [];
  let continued = false;
  const request = { auth: { userId: "synthetic-user" } } as any;
  const next = (error?: unknown) => { if (error) errors.push(error); else continued = true; };
  return { request, next, errors, owners, builders, calls: () => calls, continued: () => continued };
}

// The retry runs immediately in tests while still asserting its production delay.
async function run(h: ReturnType<typeof harness>, delays: number[] = []) {
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay: number) => {
    delays.push(delay);
    queueMicrotask(callback);
    return 0 as any;
  }) as any;
  await requireActiveAccount(h.request, {} as any, h.next);
}

test("retries the exact future-JWT error with a fresh builder and the same owner", async () => {
  const h = harness([
    { data: null, error: { code: "PGRST303", message: "JWT issued at future" } },
    { data: { account_status: "active" }, error: null },
  ]);
  const delays: number[] = [];
  await run(h, delays);
  assert.equal(h.calls(), 2);
  assert.deepEqual(h.owners, ["synthetic-user", "synthetic-user"]);
  assert.notEqual(h.builders[0], h.builders[1]);
  assert.deepEqual(delays, [1_000]);
  assert.equal(h.continued(), true);
  assert.equal(h.errors.length, 0);
});

test("persistent future-JWT failures remain a 500 after exactly two reads", async () => {
  const error = { code: "PGRST303", message: "JWT issued at future" };
  const h = harness([{ data: null, error }, { data: null, error }]);
  const originalError = console.error;
  console.error = () => {};
  try { await run(h); } finally { console.error = originalError; }
  assert.equal(h.calls(), 2);
  assert.equal(h.continued(), false);
  assert.equal(h.errors[0]?.statusCode, 500);
  assert.equal(h.errors[0]?.code, "ENTITLEMENT_QUERY_FAILED");
});

test("does not retry errors that only partially match the known failure", async () => {
  for (const error of [
    { code: "PGRST303", message: "JWT signature invalid" },
    { code: "XX000", message: "JWT issued at future" },
  ]) {
    const h = harness([{ data: null, error }]);
    const originalError = console.error;
    console.error = () => {};
    try { await run(h); } finally { console.error = originalError; }
    assert.equal(h.calls(), 1);
    assert.equal(h.continued(), false);
    assert.equal(h.errors[0]?.statusCode, 500);
  }
});

test("does not retry missing or suspended entitlements", async () => {
  for (const result of [{ data: null, error: null }, { data: { account_status: "suspended" }, error: null }]) {
    const h = harness([result]);
    await run(h);
    assert.equal(h.calls(), 1);
    assert.equal(h.continued(), false);
    assert.equal(h.errors.length, 1);
  }
});

test("rejects unauthenticated requests without querying entitlements", async () => {
  const h = harness([]);
  h.request.auth = undefined;
  await run(h);
  assert.equal(h.calls(), 0);
  assert.equal(h.errors[0]?.code, "UNAUTHENTICATED");
});
