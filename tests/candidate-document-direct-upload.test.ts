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
  let allowIntent = true;
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "candidate_documents") return {
      select: () => ({ eq: function () { return this; }, maybeSingle: async () => ({ data: null, error: null }) }),
    };
    assert.equal(table, "candidate_document_upload_intents");
    return {
      update: () => ({ eq: function () { return this; }, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) }),
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
  (supabaseAdmin as any).rpc = (name: string, args: any) => {
    if (name === "create_candidate_document_upload_intent") {
      assert.equal(args.p_user_id, "owner-a");
      assert.match(args.p_id, /^[0-9a-f-]{36}$/i);
      return Promise.resolve({ data: allowIntent, error: null });
    }
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
  allowIntent = false;
  const limited = await run(createCandidateDocumentUpload, { auth: { userId: "owner-a" } });
  assert.equal(limited.status, 429);
  allowIntent = true;

  const finalized = await run(finalizeCandidateDocumentUpload, {
    auth: { userId: "owner-a" },
    body: { uploadId, documentType: "cv", filename: "resume.md" },
  });
  assert.equal(finalized.status, 201);
  assert.equal(finalPath, `owner-a/${uploadId}/document.md`);
  assert.equal(finalBody, "Ada Lovelace\n\nEngineer");
  assert.equal(finalContentType, "text/markdown");
  assert.equal(rpcArgs.p_extracted_text, finalBody);
  assert.equal(rpcArgs.p_content_hash.length, 64);
  assert.equal(rpcArgs.p_id, uploadId);

  let cleanupPaths: string[] = [];
  let cleanupQueries = 0;
  let cleanupDeletes = 0;
  const referencedFinalPath = "owner-a/referenced-document/document.md";
  let pendingCleanup = [
    { id: uploadId, user_id: "owner-a", final_storage_path: `owner-a/${uploadId}/document.md` },
    { id: "55555555-5555-4555-8555-000000000001", user_id: "owner-a", final_storage_path: referencedFinalPath },
    ...Array.from({ length: 1000 }, (_, index) => ({ id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`, user_id: "owner-a" })),
  ];
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "candidate_documents") return {
      select: () => ({ in: async (_column: string, paths: string[]) => ({
        data: paths.includes(referencedFinalPath) ? [{ storage_path: referencedFinalPath }] : [], error: null,
      }) }),
    };
    assert.equal(table, "candidate_document_upload_intents");
    return {
      select: () => ({
        lt: function () { return this; },
        order: function () { return this; },
        limit: async (limit: number) => {
          cleanupQueries++;
          assert.ok(cleanupQueries <= 20, `cleanup must make progress (queries=${cleanupQueries}, deletes=${cleanupDeletes}, pending=${pendingCleanup.length})`);
          assert.equal(limit, 100);
          return { data: pendingCleanup.slice(0, limit), error: null };
        },
      }),
      delete: () => ({ in: async (_column: string, ids: string[]) => {
        cleanupDeletes++;
        const deleted = new Set(ids);
        pendingCleanup = pendingCleanup.filter(row => !deleted.has(row.id));
        return { error: null };
      } }),
    };
  };
  (supabaseAdmin as any).storage.from = () => ({
    remove: async (paths: string[]) => { cleanupPaths.push(...paths); return { error: null }; },
  });
  const unauthenticatedCleanup = await run(cleanupCandidateDocumentUploads, { headers: {} });
  assert.equal(unauthenticatedCleanup.status, 401);
  const cleanup = await run(cleanupCandidateDocumentUploads, { headers: { authorization: "Bearer synthetic-cron-secret" } });
  assert.equal(cleanup.status, 200);
  assert.equal(cleanupPaths[0], `owner-a/${uploadId}/source`);
  assert.equal(cleanup.body.data.examined, 1002);
  assert.equal(cleanup.body.data.removed, 1002);
  assert.equal(cleanupPaths.length, 1003);
  assert.ok(cleanupPaths.includes(`owner-a/${uploadId}/document.md`));
  assert.equal(cleanupPaths.includes(referencedFinalPath), false);
  assert.equal(cleanupQueries, 12);
  assert.equal(cleanupDeletes, 11);
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
      update: () => ({ eq: function () { return this; }, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) }),
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

test("direct finalization retries an orphaned Markdown object after an ambiguous RPC failure", async () => {
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
  const uploadId = "22222222-2222-4222-8222-222222222222";
  const objects = new Map<string, Buffer>();
  let document: any = null;
  let rpcCalls = 0;
  let uploadCalls = 0;
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "candidate_document_upload_intents") return {
      update: () => ({ eq: function () { return this; }, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) }),
      select: () => ({ eq: function () { return this; }, maybeSingle: async () => ({ data: { id: uploadId, purge_after: new Date(Date.now() + 60_000).toISOString() }, error: null }) }),
    };
    return { select: () => ({ eq: function () { return this; }, maybeSingle: async () => ({ data: document, error: null }) }) };
  };
  (supabaseAdmin as any).storage.from = (bucket: string) => bucket === "candidate-document-staging" ? {
    download: async () => ({ data: new Blob(["Retry me\n"]), error: null }),
  } : {
    upload: async (path: string, body: Buffer) => {
      uploadCalls++;
      if (objects.has(path)) return { error: { code: "Duplicate" } };
      objects.set(path, Buffer.from(body));
      return { error: null };
    },
    download: async (path: string) => objects.has(path)
      ? { data: new Blob([objects.get(path)!]), error: null }
      : { data: null, error: { code: "NotFound" } },
    remove: async (paths: string[]) => { for (const path of paths) objects.delete(path); return { error: null }; },
  };
  (supabaseAdmin as any).rpc = () => ({ single: async () => {
    rpcCalls++;
    if (rpcCalls === 1) return { data: null, error: { code: "08006" } };
    document = {
      id: uploadId, user_id: "owner-a", document_type: "cv", filename: "retry.md",
      storage_path: `owner-a/${uploadId}/document.md`, extracted_text: "Retry me", content_hash: "synthetic-hash",
      revision: 1, is_active: true,
    };
    return { data: document, error: null };
  } });

  const run = async () => {
    let status = 0;
    let body: any;
    const response: any = { status: (value: number) => { status = value; return response; }, json: (value: any) => { body = value; return response; } };
    await finalizeCandidateDocumentUpload({ auth: { userId: "owner-a" }, body: { uploadId, documentType: "cv", filename: "retry.md" } } as any, response);
    return { status, body };
  };

  const firstAttempt = await run();
  assert.equal(firstAttempt.status, 503);
  assert.equal(firstAttempt.body.error.code, "DOCUMENT_UPLOAD_RETRYABLE");
  const retried = await run();
  assert.equal(retried.status, 201);
  assert.equal(retried.body.data.id, uploadId);
  assert.equal(uploadCalls, 2);
  assert.equal(rpcCalls, 2);
  assert.equal(objects.get(`owner-a/${uploadId}/document.md`)?.toString(), "Retry me");
});

test("concurrent finalizations for the same upload return the winning document", async () => {
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
  const uploadId = "33333333-3333-4333-8333-333333333333";
  const objects = new Map<string, Buffer>();
  let document: any = null;
  let documentLookups = 0;
  let rpcCalls = 0;
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "candidate_document_upload_intents") return {
      update: () => ({ eq: function () { return this; }, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) }),
      select: () => ({ eq: function () { return this; }, maybeSingle: async () => ({ data: { id: uploadId, purge_after: new Date(Date.now() + 60_000).toISOString() }, error: null }) }),
    };
    return { select: () => ({ eq: function () { return this; }, maybeSingle: async () => {
      documentLookups++;
      return { data: documentLookups <= 2 ? null : document, error: null };
    } }) };
  };
  (supabaseAdmin as any).storage.from = (bucket: string) => bucket === "candidate-document-staging" ? {
    download: async () => ({ data: new Blob(["Concurrent"]), error: null }),
  } : {
    upload: async (path: string, body: Buffer) => {
      if (objects.has(path)) return { error: { code: "Duplicate" } };
      objects.set(path, Buffer.from(body));
      return { error: null };
    },
    download: async (path: string) => objects.has(path)
      ? { data: new Blob([objects.get(path)!]), error: null }
      : { data: null, error: { code: "NotFound" } },
    remove: async () => ({ error: null }),
  };
  (supabaseAdmin as any).rpc = (_name: string, args: any) => ({ single: async () => {
    rpcCalls++;
    const row = {
      id: args.p_id, user_id: args.p_user_id, document_type: args.p_document_type, filename: args.p_filename,
      storage_path: args.p_storage_path, extracted_text: args.p_extracted_text, content_hash: args.p_content_hash,
      revision: 1, is_active: true,
    };
    if (rpcCalls === 1) { document = row; return { data: row, error: null }; }
    return { data: null, error: { code: "23505" } };
  } });

  const run = async () => {
    let status = 0;
    let body: any;
    const response: any = { status: (value: number) => { status = value; return response; }, json: (value: any) => { body = value; return response; } };
    await finalizeCandidateDocumentUpload({ auth: { userId: "owner-a" }, body: { uploadId, documentType: "cv", filename: "same.md" } } as any, response);
    return { status, body };
  };
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(result => result.status), [201, 201]);
  assert.equal(results[0].body.data.id, uploadId);
  assert.equal(results[1].body.data.id, uploadId);
  assert.equal(rpcCalls, 2);
});
