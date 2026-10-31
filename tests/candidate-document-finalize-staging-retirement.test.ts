import assert from "node:assert/strict";
import { test } from "node:test";

type Scenario = "success" | "ambiguous_commit" | "remove_failure" | "source_missing";

async function runFinalize(scenario: Scenario) {
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: new URL("./fixtures/no-runtime-env", import.meta.url).pathname,
    NODE_ENV: "test",
    FRONTEND_URL: "http://localhost:3001",
    SUPABASE_URL: "https://synthetic.invalid",
    SUPABASE_PUBLISHABLE_KEY: "synthetic-publishable",
    SUPABASE_SECRET_KEY: "synthetic-secret",
    OPENROUTER_API_KEY: "synthetic",
    JOBSDB_API_KEY: "synthetic",
    TYPESAFE_API_KEY: "synthetic",
    SKILLS_JSON_GENERATION_MODEL: "synthetic",
    COVER_LETTER_CODEX_MODEL: "synthetic",
  });
  const { supabaseAdmin } = await import("../src/config/supabase.js");
  const { finalizeCandidateDocumentUpload } = await import("../src/modules/candidate/candidate.controller.js");

  const owner = "00000000-0000-4000-8000-000000000001";
  const uploadId = "11111111-1111-4111-8111-111111111111";
  const sourcePath = `${owner}/${uploadId}/source`;
  const events: string[] = [];
  let document: any = null;
  let removalCalls = 0;
  let sourceExists = scenario !== "source_missing";
  let cleanupReleaseCalls = 0;
  let finalizationReleaseCalls = 0;

  (supabaseAdmin as any).from = (table: string) => {
    assert.equal(table, "candidate_documents");
    return {
      select: () => ({
        eq: function () { return this; },
        maybeSingle: async () => ({ data: document, error: null }),
      }),
    };
  };
  (supabaseAdmin as any).storage.from = (bucket: string) => {
    if (bucket === "candidate-document-staging") {
      return {
        download: async (path: string) => {
          assert.equal(path, sourcePath);
          return { data: new Blob(["Synthetic candidate notes"]), error: null };
        },
        remove: async (paths: string[]) => {
          removalCalls++;
          events.push("remove-source");
          assert.deepEqual(paths, [sourcePath]);
          if (scenario === "remove_failure") return { data: null, error: { code: "503" } };
          if (!sourceExists) return { data: [], error: null };
          sourceExists = false;
          return { data: [{ name: sourcePath }], error: null };
        },
      };
    }
    assert.equal(bucket, "candidate-documents");
    return {
      upload: async (_path: string, _bytes: Buffer) => ({ error: null }),
      download: async () => ({ data: null, error: { code: "NotFound" } }),
    };
  };
  (supabaseAdmin as any).rpc = (name: string, args: any) => {
    switch (name) {
      case "claim_candidate_document_upload_finalization":
        events.push("claim-finalization");
        return Promise.resolve({ data: "claimed", error: null });
      case "complete_candidate_document_upload_finalization":
        events.push("publish");
        return {
          single: async () => {
            document = {
              id: uploadId,
              user_id: owner,
              document_type: "cv",
              filename: "resume.txt",
              storage_path: args.p_storage_path,
              extracted_text: args.p_extracted_text,
              content_hash: args.p_content_hash,
              revision: 1,
              is_active: true,
            };
            if (scenario === "ambiguous_commit") {
              return { data: null, error: { code: "08006", message: "Synthetic lost response" } };
            }
            return { data: document, error: null };
          },
        };
      case "claim_finalized_candidate_document_upload_retirement":
        events.push("claim-retirement");
        return Promise.resolve({ data: "claimed", error: null });
      case "release_candidate_document_upload_cleanup":
        events.push("release-retirement-claim");
        cleanupReleaseCalls++;
        return Promise.resolve({ data: 1, error: null });
      case "release_candidate_document_upload_finalization":
        finalizationReleaseCalls++;
        return Promise.resolve({ data: true, error: null });
      default:
        throw new Error(`Unexpected RPC ${name}`);
    }
  };

  let status = 0;
  let body: any;
  const response: any = {
    status: (value: number) => { status = value; return response; },
    json: (value: any) => { body = value; return response; },
  };
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await finalizeCandidateDocumentUpload(
      {
        auth: { userId: owner },
        body: { uploadId, documentType: "cv", filename: "resume.txt" },
      } as any,
      response,
    );
  } finally {
    console.error = originalConsoleError;
  }
  return {
    status,
    body,
    events,
    get removalCalls() { return removalCalls; },
    get sourceExists() { return sourceExists; },
    get cleanupReleaseCalls() { return cleanupReleaseCalls; },
    get finalizationReleaseCalls() { return finalizationReleaseCalls; },
    runAgain: async () => {
      status = 0;
      body = undefined;
      await finalizeCandidateDocumentUpload(
        {
          auth: { userId: owner },
          body: { uploadId, documentType: "cv", filename: "resume.txt" },
        } as any,
        response,
      );
      return { status, body };
    },
    recreateSourceFromSignedToken: () => { sourceExists = true; },
  };
}

test("finalization retires staging without weakening idempotent publication", async t => {
  await t.test("success removes source, then an idempotent signed-token replay is removed again", async () => {
    const run = await runFinalize("success");
    assert.equal(run.status, 201);
    assert.equal(run.sourceExists, false);
    assert.deepEqual(run.events.slice(-4), ["publish", "claim-retirement", "remove-source", "release-retirement-claim"]);
    run.recreateSourceFromSignedToken();
    assert.equal(run.sourceExists, true);
    const retry = await run.runAgain();
    assert.equal(retry.status, 201);
    assert.equal(run.removalCalls, 2, "an idempotent retry removes a source recreated with a still-valid upload token");
    assert.equal(run.sourceExists, false);
  });

  await t.test("ambiguous publication success is reconciled, then staged bytes are retired", async () => {
    const run = await runFinalize("ambiguous_commit");
    assert.equal(run.status, 201);
    assert.deepEqual(run.events.slice(-4), ["publish", "claim-retirement", "remove-source", "release-retirement-claim"]);
    assert.equal(run.finalizationReleaseCalls, 0, "ambiguous commit retains the publication lease semantics");
  });

  await t.test("source removal failure keeps finalized tombstone and scheduled cleanup fallback", async () => {
    const run = await runFinalize("remove_failure");
    assert.equal(run.status, 201, "best-effort cleanup does not turn a published document into a failed upload");
    assert.equal(run.cleanupReleaseCalls, 1);
  });

  await t.test("missing source is treated as an idempotent removal", async () => {
    const run = await runFinalize("source_missing");
    assert.equal(run.status, 201);
    assert.equal(run.removalCalls, 1);
    assert.equal(run.cleanupReleaseCalls, 1);
  });
});
