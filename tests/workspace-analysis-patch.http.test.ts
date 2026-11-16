// Audience: maintainers and agents. Offline contract coverage; no live account, network, or provider calls.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { supabaseAdmin } from "../src/config/supabase.js";
import { jobRouter } from "../src/modules/jobs/job.routes.js";
import { patchWorkspaceAnalyses } from "../src/modules/jobs/workspace.controller.js";

const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
afterEach(() => { supabaseAdmin.rpc = originalRpc as any; });

function response() {
  return { statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; } } as any;
}
function payload() {
  return { sourceSite: "configured", jobs: [{ id: "posting-1", source: "jobsdb", prescriptiveScore: null,
    summaryJson: null, llmVerifiedLocation: null, locationMismatch: null, otherData: {} }] };
}

test("PATCH analysis accepts only bounded analysis fields and binds RPC owner from authenticated request", async () => {
  let called: any;
  supabaseAdmin.rpc = (async (name: string, args: any) => {
    called = { name, args };
    return { data: [{ external_id: "posting-1", id: "canonical-job-id" }], error: null };
  }) as any;
  const res = response();
  await patchWorkspaceAnalyses({ body: payload(), auth: { userId: "authenticated-owner" } } as any, res);
  assert.equal(called.name, "save_job_analyses");
  assert.equal(called.args.p_user_id, "authenticated-owner");
  assert.equal(called.args.p_source, "configured");
  assert.deepEqual(res.body, { data: [{ external_id: "posting-1", id: "canonical-job-id" }] });

  for (const forbidden of ["description", "apiJobData", "applicationStatus", "applicationNotes", "generatedCoverLetter", "generatedFuqAnswers"]) {
    const bad = payload();
    (bad.jobs[0] as any)[forbidden] = "must be rejected";
    await assert.rejects(patchWorkspaceAnalyses({ body: bad, auth: { userId: "authenticated-owner" } } as any, response()));
  }
});

test("PATCH rejects duplicate jobs and a source mismatch before any RPC call", async () => {
  let calls = 0;
  supabaseAdmin.rpc = (async () => { calls++; return { data: [], error: null }; }) as any;
  const duplicate = payload(); duplicate.jobs.push({ ...duplicate.jobs[0]! });
  await assert.rejects(patchWorkspaceAnalyses({ body: duplicate, auth: { userId: "owner" } } as any, response()), /Duplicate workspace job IDs/);
  const mismatch = payload(); mismatch.sourceSite = "jobsdb"; mismatch.jobs[0]!.source = "greenhouse";
  const res = response();
  await patchWorkspaceAnalyses({ body: mismatch, auth: { userId: "owner" } } as any, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, "INVALID_WORKSPACE_SOURCE");
  assert.equal(calls, 0);
});

test("analysis endpoint is PATCH-only and keeps the existing authenticated active-account route chain", () => {
  const layer = (jobRouter as any).stack.find((candidate: any) => candidate.route?.path === "/workspace/analyses");
  assert.ok(layer, "analysis patch route exists");
  assert.equal(layer.route.methods.patch, true);
  assert.deepEqual(Object.keys(layer.route.methods), ["patch"]);
  assert.equal(layer.route.stack.length, 3, "authentication and active-account checks run before the handler");
  const handlers = layer.route.stack.map((entry: any) => entry.handle);
  assert.ok(handlers.includes(patchWorkspaceAnalyses));
});

// Known aborts may be retried; unrelated database failures must not become a safe-abort claim.
test("analysis patch classifies only exact conflict and statement timeout errors", async () => {
  const cases = [
    [{code:"57014",message:"canceling statement due to statement timeout"},"WORKSPACE_SAVE_TIMEOUT"],
    [{code:"P0001",message:"WORKSPACE_ANALYSIS_CONFLICT"},"WORKSPACE_ANALYSIS_CONFLICT"],
  ];
  for (const [error, code] of cases) {
    supabaseAdmin.rpc = (async () => ({data:null,error})) as any;
    await assert.rejects(patchWorkspaceAnalyses({body:payload(),auth:{userId:"owner"}} as any,response()), (caught:any) => caught.code===code);
  }
  const cancelled={code:"57014",message:"canceling statement due to user request"};
  supabaseAdmin.rpc = (async()=>({data:null,error:cancelled})) as any;
  await assert.rejects(patchWorkspaceAnalyses({body:payload(),auth:{userId:"owner"}} as any,response()), (caught:any)=>caught===cancelled);
});
