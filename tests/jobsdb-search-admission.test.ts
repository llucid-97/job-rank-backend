import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { supabaseAdmin } from "../src/config/supabase.js";
import { AppError } from "../src/middleware/error-handling.js";
import { searchJobs } from "../src/modules/jobs/job.controller.js";

Object.assign(process.env, {
  NODE_ENV: "test",
  JOBSDB_API_KEY: "synthetic-jobs",
  JOBSDB_API_HOST_ATS: "synthetic.invalid",
  JOBSDB_API_ENDPOINT: "/search",
});

const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalFetch = globalThis.fetch;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

afterEach(() => {
  supabaseAdmin.rpc = originalRpc as any;
  supabaseAdmin.from = originalFrom as any;
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
});

function response() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as any,
    set(name: string, value: string) { this.headers[name.toLowerCase()] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) { this.body = body; return this; },
  } as any;
}

function request(body: Record<string, unknown> = { query: "synthetic", persistResults: false }) {
  return { auth: { userId: "00000000-0000-0000-0000-000000000001" }, body } as any;
}

function database(events: string[], outcomes: { admitted?: boolean; quota?: boolean; released?: boolean } = {}) {
  supabaseAdmin.rpc = (async (name: string) => {
    events.push(name);
    if (name === "acquire_jobsdb_search_lease") return { data: outcomes.admitted ?? true, error: null };
    if (name === "consume_provider_quota") return { data: outcomes.quota ?? true, error: null };
    if (name === "release_jobsdb_search_lease") return { data: outcomes.released ?? true, error: null };
    throw new Error(`Unexpected RPC ${name}`);
  }) as any;
  supabaseAdmin.from = ((table: string) => {
    let values: any[] = [];
    const builder: any = {
      upsert(next: any[]) { values = Array.isArray(next) ? next : [next]; events.push(`upsert:${table}`); return builder; },
      select() { return Promise.resolve({ data: values.map((value, index) => ({ id: `${table}-${index}`, ...value })), error: null }); },
      then(resolve: any, reject: any) { return Promise.resolve({ data: null, error: null }).then(resolve, reject); },
    };
    return builder;
  }) as any;
}

test("busy admission returns retryable 429 before quota or provider fetch", async () => {
  const events: string[] = [];
  database(events, { admitted: false });
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; return new Response("{\"jobs\":[]}"); }) as typeof fetch;

  const result = response();
  await searchJobs(request(), result);

  assert.equal(result.statusCode, 429);
  assert.equal(result.headers["retry-after"], "5");
  assert.equal(result.body.error.code, "JOB_SEARCH_BUSY");
  assert.deepEqual(events, ["acquire_jobsdb_search_lease"]);
  assert.equal(providerCalls, 0);
});

test("monthly quota denial releases the lease without calling JobsDB", async () => {
  const events: string[] = [];
  database(events, { quota: false });
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; return new Response("{\"jobs\":[]}"); }) as typeof fetch;

  await assert.rejects(
    searchJobs(request(), response()),
    error => error instanceof AppError && error.code === "QUOTA_EXCEEDED",
  );
  assert.deepEqual(events, [
    "acquire_jobsdb_search_lease",
    "consume_provider_quota",
    "release_jobsdb_search_lease",
  ]);
  assert.equal(providerCalls, 0);
});

test("admission RPC failure fails closed before quota or provider fetch", async () => {
  const events: string[] = [];
  database(events);
  supabaseAdmin.rpc = (async (name: string) => {
    events.push(name);
    return { data: null, error: new Error("synthetic RPC failure") };
  }) as any;
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; return new Response("{\"jobs\":[]}"); }) as typeof fetch;

  await assert.rejects(
    searchJobs(request(), response()),
    error => error instanceof AppError && error.code === "JOB_SEARCH_ADMISSION_UNAVAILABLE" && error.statusCode === 503,
  );
  assert.deepEqual(events, ["acquire_jobsdb_search_lease"]);
  assert.equal(providerCalls, 0);
});

test("provider failure releases its admission lease after charging the monthly unit", async () => {
  const events: string[] = [];
  database(events);
  globalThis.fetch = (async () => {
    events.push("provider-fetch");
    return new Response(null, { status: 503 });
  }) as typeof fetch;

  await assert.rejects(
    searchJobs(request(), response()),
    error => error instanceof AppError && error.code === "JOB_PROVIDER_UNAVAILABLE",
  );
  assert.deepEqual(events, [
    "acquire_jobsdb_search_lease",
    "consume_provider_quota",
    "provider-fetch",
    "release_jobsdb_search_lease",
  ]);
});

test("successful search releases its lease after saving the job and search history", async () => {
  const events: string[] = [];
  database(events);
  globalThis.fetch = (async () => {
    events.push("provider-fetch");
    return new Response(JSON.stringify({ jobs: [{ id: "one", title: "Developer" }] }));
  }) as typeof fetch;

  const result = response();
  await searchJobs(request(), result);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.length, 1);
  assert.deepEqual(events, [
    "acquire_jobsdb_search_lease",
    "consume_provider_quota",
    "provider-fetch",
    "upsert:jobs",
    "upsert:saved_searches",
    "release_jobsdb_search_lease",
  ]);
});
