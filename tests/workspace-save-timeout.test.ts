// Audience: maintainers. Protect the exact database-abort recovery contract.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

Object.assign(process.env, {
  NODE_ENV: "test",
  SUPABASE_URL: "https://synthetic.invalid",
  SUPABASE_PUBLISHABLE_KEY: "synthetic-public",
  SUPABASE_SECRET_KEY: "synthetic-secret",
});

const { supabaseAdmin } = await import("../src/config/supabase.js");
const { saveWorkspace } = await import("../src/modules/jobs/workspace.controller.js");
const { AppError } = await import("../src/middleware/error-handling.js");
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

afterEach(() => { supabaseAdmin.rpc = originalRpc as any; });

function request(log?: any) {
  return {
    auth: { userId: "owner-a" },
    body: { sourceSite: "configured", jobs: [] },
    log,
  } as any;
}

function response() {
  return { json(body: unknown) { return body; } } as any;
}

async function saveWith(result: any, log?: any) {
  supabaseAdmin.rpc = (async () => result) as any;
  return saveWorkspace(request(log), response());
}

// Even errors carrying private details must become only a fixed public classification.
test("maps only the confirmed statement-timeout abort to a safe retryable API error", async () => {
  const records: any[] = [];
  const log = { error: (...args: any[]) => records.push(args) };
  await assert.rejects(
    () => saveWith({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout", details: "private candidate data" } }, log),
    (error: any) => error instanceof AppError
      && error.statusCode === 503
      && error.code === "WORKSPACE_SAVE_TIMEOUT"
      && error.message === "Saving your workspace took too long. Please retry."
      && error.details === undefined,
  );
  assert.deepEqual(records, [[
    { event: "workspace.save.rejected", reason: "statement_timeout", db_code: "57014" },
    "Workspace save rejected",
  ]]);
});

test("preserves unrelated PostgreSQL cancellation errors", async () => {
  const error = { code: "57014", message: "canceling statement due to user request" };
  await assert.rejects(() => saveWith({ data: null, error }), value => value === error);
});

test("preserves generic RPC failures", async () => {
  const error = { code: "XX000", message: "database failure" };
  await assert.rejects(() => saveWith({ data: null, error }), value => value === error);
});

test("returns successful RPC data unchanged", async () => {
  const data = { saved: 2 };
  assert.deepEqual(await saveWith({ data, error: null }), { data });
});
