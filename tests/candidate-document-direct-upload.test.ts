import { test } from "node:test";
import assert from "node:assert/strict";

test("direct upload intent is owner-bound and finalization stores normalized Markdown", async () => {
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
    CRON_SECRET: "synthetic-cron-secret",
  });
  globalThis.fetch = async () => { throw new Error("Network prohibited"); };
  const { supabaseAdmin } = await import("../src/config/supabase.ts");
  const { createCandidateDocumentUpload, finalizeCandidateDocumentUpload, cleanupCandidateDocumentUploads } =
    await import("../src/modules/candidate/candidate.controller.ts");

  let stagingPath = "";
  let finalPath = "";
  let finalBody = "";
  let finalContentType = "";
  let rpcArgs: any;
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "candidate_documents") return {
      select: () => ({ eq: function () { return this; }, maybeSingle: async () => ({ data: null, error: null }) }),
    };
    assert.equal(table, "candidate_document_upload_intents");
    return {
      insert: async (row: any) => {
        assert.equal(row.user_id, "owner-a");
        assert.match(row.id, /^[0-9a-f-]{36}$/i);
        return { error: null };
      },
      select: () => ({
        eq: function () { return this; },
        maybeSingle: async () => ({ data: { id: uploadId, purge_after: new Date(Date.now() + 60_000).toISOString() }, error: null }),
      }),
    };
  };
  let uploadId = "";
  (supabaseAdmin as any).storage.from = (bucket: string) => {
    if (bucket === "candidate-document-staging") return {
      createSignedUploadUrl: async (path: string, options: any) => {
        stagingPath = path;
        assert.equal(options.upsert, false);
        uploadId = path.split("/")[1];
        return { data: { path, token: "synthetic-token", signedUrl: "/ignored" }, error: null };
      },
      download: async (path: string) => {
        assert.equal(path, stagingPath);
        return { data: new Blob(["  Ada Lovelace  \r\n\r\n\r\nEngineer  "]), error: null };
      },
    };
    assert.equal(bucket, "candidate-documents");
    return {
      upload: async (path: string, body: Buffer, options: any) => {
        finalPath = path;
        finalBody = body.toString("utf8");
        finalContentType = options.contentType;
        return { error: null };
      },
    };
  };
  (supabaseAdmin as any).rpc = (_name: string, args: any) => {
    rpcArgs = args;
    return { single: async () => ({ data: { id: args.p_id, revision: 1, is_active: true }, error: null }) };
  };

  const run = async (handler: Function, request: any) => {
    let status = 0;
    let body: any;
    const response: any = {
      status: (value: number) => { status = value; return response; },
      json: (value: any) => { body = value; return response; },
    };
    await handler(request, response);
    return { status, body };
  };

  const created = await run(createCandidateDocumentUpload, { auth: { userId: "owner-a" } });
  assert.equal(created.status, 201);
  assert.match(stagingPath, /^owner-a\/[0-9a-f-]{36}\/source$/i);
  assert.equal(created.body.data.path, stagingPath);

  const finalized = await run(finalizeCandidateDocumentUpload, {
    auth: { userId: "owner-a" },
    body: { uploadId, documentType: "cv", filename: "resume.md" },
  });
  assert.equal(finalized.status, 201);
  assert.equal(finalPath, `owner-a/${uploadId}/resume.md`);
  assert.equal(finalBody, "Ada Lovelace\n\nEngineer");
  assert.equal(finalContentType, "text/markdown");
  assert.equal(rpcArgs.p_extracted_text, finalBody);
  assert.equal(rpcArgs.p_content_hash.length, 64);
  assert.equal(rpcArgs.p_id, uploadId);

  let cleanupPath = "";
  (supabaseAdmin as any).from = (table: string) => {
    assert.equal(table, "candidate_document_upload_intents");
    return {
      select: () => ({
        lt: function () { return this; },
        order: function () { return this; },
        limit: async (limit: number) => {
          assert.equal(limit, 1000);
          return { data: [{ id: uploadId, user_id: "owner-a" }], error: null };
        },
      }),
      delete: () => ({ in: async () => ({ error: null }) }),
    };
  };
  (supabaseAdmin as any).storage.from = () => ({
    remove: async (paths: string[]) => { cleanupPath = paths[0]; return { error: null }; },
  });
  const unauthenticatedCleanup = await run(cleanupCandidateDocumentUploads, { headers: {} });
  assert.equal(unauthenticatedCleanup.status, 401);
  const cleanup = await run(cleanupCandidateDocumentUploads, { headers: { authorization: "Bearer synthetic-cron-secret" } });
  assert.equal(cleanup.status, 200);
  assert.equal(cleanupPath, `owner-a/${uploadId}/source`);
  assert.equal(cleanup.body.data.removed, 1);
});

test("direct finalization rejects a PDF signature mismatch before publication", async () => {
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
  const { supabaseAdmin } = await import("../src/config/supabase.ts");
  const { finalizeCandidateDocumentUpload } = await import("../src/modules/candidate/candidate.controller.ts");
  const uploadId = "11111111-1111-4111-8111-111111111111";
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "candidate_document_upload_intents") return {
      select: () => ({ eq: function () { return this; }, maybeSingle: async () => ({ data: { id: uploadId, purge_after: new Date(Date.now() + 60_000).toISOString() }, error: null }) }),
    };
    return { select: () => ({ eq: function () { return this; }, maybeSingle: async () => ({ data: null, error: null }) }) };
  };
  let published = false;
  (supabaseAdmin as any).storage.from = () => ({ download: async () => ({ data: new Blob(["not a pdf"]), error: null }), upload: async () => { published = true; return { error: null }; } });
  let status = 0;
  let body: any;
  const response: any = { status: (value: number) => { status = value; return response; }, json: (value: any) => { body = value; return response; } };
  await finalizeCandidateDocumentUpload({ auth: { userId: "owner-a" }, body: { uploadId, documentType: "cv", filename: "resume.pdf" } } as any, response);
  assert.equal(status, 422);
  assert.equal(body.error.code, "INVALID_DOCUMENT");
  assert.equal(published, false);
});
