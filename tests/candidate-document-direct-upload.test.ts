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
  let finalizedRow: any = null;
  let pendingCleanup: Array<{ id: string; user_id: string; final_storage_path: string | null }> = [];
  let cleanupQueries = 0;
  let cleanupDeletes = 0;
  const referencedFinalPath = "owner-a/referenced-document/document.md";
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "candidate_documents") return {
      select: () => ({
        eq: function () { return this; },
        maybeSingle: async () => ({ data: finalizedRow, error: null }),
        in: async (_column: string, paths: string[]) => ({
          data: paths.filter(path => path === finalPath || path === referencedFinalPath).map(storage_path => ({ storage_path })), error: null,
        }),
      }),
    };
    throw new Error(`Unexpected table ${table}`);
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
    if (name === "claim_candidate_document_upload_finalization") return Promise.resolve({ data: "claimed", error: null });
    if (name === "complete_candidate_document_upload_finalization") {
      rpcArgs = args;
      finalizedRow = {
        id: args.p_id, user_id: args.p_user_id, document_type: args.p_document_type,
        filename: args.p_filename, storage_path: args.p_storage_path,
        extracted_text: args.p_extracted_text, content_hash: args.p_content_hash,
        revision: 1, is_active: true,
      };
      return { single: async () => ({ data: finalizedRow, error: null }) };
    }
    if (name === "claim_candidate_document_uploads_for_cleanup") {
      cleanupQueries++;
      assert.ok(cleanupQueries <= 20, `cleanup must make progress (queries=${cleanupQueries}, deletes=${cleanupDeletes}, pending=${pendingCleanup.length})`);
      assert.equal(args.p_limit, 100);
      return Promise.resolve({ data: pendingCleanup.slice(0, args.p_limit), error: null });
    }
    if (name === "delete_candidate_document_uploads_after_cleanup") {
      cleanupDeletes++;
      const deleted = new Set(args.p_ids);
      pendingCleanup = pendingCleanup.filter(row => !deleted.has(row.id));
      return Promise.resolve({ data: args.p_ids.length, error: null });
    }
    if (name.startsWith("release_candidate_document_upload_")) return Promise.resolve({ data: 1, error: null });
    throw new Error(`Unexpected RPC ${name}`);
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

  finalizedRow = { ...finalized.body.data, document_type: "cv", filename: "resume.md" };
  const conflictingRetry = await run(finalizeCandidateDocumentUpload, {
    auth: { userId: "owner-a" },
    body: { uploadId, documentType: "about_you", filename: "resume.md" },
  });
  assert.equal(conflictingRetry.status, 409);
  assert.equal(conflictingRetry.body.error.code, "UPLOAD_ALREADY_FINALIZED");

  const cleanupPathsByBucket = new Map<string, string[]>();
  pendingCleanup = [
    { id: uploadId, user_id: "owner-a", final_storage_path: `owner-a/${uploadId}/document.md` },
    { id: "55555555-5555-4555-8555-000000000001", user_id: "owner-a", final_storage_path: referencedFinalPath },
    { id: "66666666-6666-4666-8666-000000000001", user_id: "owner-a", final_storage_path: "owner-a/orphan-document/document.md" },
    ...Array.from({ length: 1000 }, (_, index) => ({ id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`, user_id: "owner-a" })),
  ];
  (supabaseAdmin as any).storage.from = (bucket: string) => ({
    remove: async (paths: string[]) => {
      const bucketPaths = cleanupPathsByBucket.get(bucket) ?? [];
      bucketPaths.push(...paths);
      cleanupPathsByBucket.set(bucket, bucketPaths);
      return { error: null };
    },
  });
  const unauthenticatedCleanup = await run(cleanupCandidateDocumentUploads, { headers: {} });
  assert.equal(unauthenticatedCleanup.status, 401);
  const cleanup = await run(cleanupCandidateDocumentUploads, { headers: { authorization: "Bearer synthetic-cron-secret" } });
  assert.equal(cleanup.status, 200);
  assert.equal(cleanup.body.data.examined, 1003);
  assert.equal(cleanup.body.data.removed, 1003);
  const stagingPaths = cleanupPathsByBucket.get("candidate-document-staging") ?? [];
  const finalPaths = cleanupPathsByBucket.get("candidate-documents") ?? [];
  assert.equal(stagingPaths.length, 1003);
  assert.ok(stagingPaths.includes(`owner-a/${uploadId}/source`));
  assert.equal(stagingPaths.includes(`owner-a/${uploadId}/document.md`), false);
  assert.deepEqual(finalPaths, ["owner-a/orphan-document/document.md"]);
  assert.equal(finalPaths.includes(referencedFinalPath), false);
  assert.equal(cleanupQueries, 12);
  assert.equal(cleanupDeletes, 11);
  const retryAfterIntentCleanup = await run(finalizeCandidateDocumentUpload, {
    auth: { userId: "owner-a" },
    body: { uploadId, documentType: "cv", filename: "resume.md" },
  });
  assert.equal(retryAfterIntentCleanup.status, 201, "a committed document remains idempotently readable after its cleanup intent is removed");
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
    CRON_SECRET: "synthetic-cron-secret",
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
  (supabaseAdmin as any).rpc = (name: string) => {
    if (name === "claim_candidate_document_upload_finalization") return Promise.resolve({ data: "claimed", error: null });
    if (name === "release_candidate_document_upload_finalization") return Promise.resolve({ data: true, error: null });
    throw new Error(`Unexpected RPC ${name}`);
  };
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
    CRON_SECRET: "synthetic-cron-secret",
  });
  const { supabaseAdmin } = await import("../src/config/supabase.ts");
  const { finalizeCandidateDocumentUpload, cleanupCandidateDocumentUploads } = await import("../src/modules/candidate/candidate.controller.ts");
  const uploadId = "22222222-2222-4222-8222-222222222222";
  const objects = new Map<string, Buffer>();
  let document: any = null;
  let rpcCalls = 0;
  let uploadCalls = 0;
  let finalizationLeaseActive = false;
  let releaseCalls = 0;
  let cleanupRemovalCalls = 0;
  let intentExpired = false;
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "candidate_document_upload_intents") return {
      update: () => ({ eq: function () { return this; }, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) }),
      select: () => ({ eq: function () { return this; }, maybeSingle: async () => ({ data: { id: uploadId, purge_after: new Date(Date.now() + 60_000).toISOString() }, error: null }) }),
    };
    return { select: () => ({
      eq: function () { return this; },
      maybeSingle: async () => ({ data: document, error: null }),
      in: async () => ({ data: [], error: null }),
    }) };
  };
  (supabaseAdmin as any).storage.from = (bucket: string) => bucket === "candidate-document-staging" ? {
    download: async () => ({ data: new Blob(["Retry me\n"]), error: null }),
    remove: async () => { cleanupRemovalCalls++; return { error: null }; },
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
    remove: async (paths: string[]) => { cleanupRemovalCalls++; for (const path of paths) objects.delete(path); return { error: null }; },
  };
  (supabaseAdmin as any).rpc = (name: string, args: any) => {
    if (name === "claim_candidate_document_upload_finalization") {
      if (finalizationLeaseActive) return Promise.resolve({ data: "busy", error: null });
      finalizationLeaseActive = true;
      return Promise.resolve({ data: "claimed", error: null });
    }
    if (name === "release_candidate_document_upload_finalization") {
      releaseCalls++;
      finalizationLeaseActive = false;
      return Promise.resolve({ data: true, error: null });
    }
    if (name === "claim_candidate_document_uploads_for_cleanup") {
      const data = intentExpired && !finalizationLeaseActive
        ? [{ id: uploadId, user_id: "owner-a", final_storage_path: `owner-a/${uploadId}/document.md` }]
        : [];
      return Promise.resolve({ data, error: null });
    }
    if (name === "delete_candidate_document_uploads_after_cleanup") {
      return Promise.resolve({ data: args.p_ids.length, error: null });
    }
    if (name === "release_candidate_document_upload_cleanup") {
      return Promise.resolve({ data: args.p_ids.length, error: null });
    }
    assert.equal(name, "complete_candidate_document_upload_finalization");
    return { single: async () => {
      rpcCalls++;
      if (rpcCalls === 1) return { data: null, error: { code: "08006" } };
      document = {
        id: uploadId, user_id: "owner-a", document_type: "cv", filename: "retry.md",
        storage_path: args.p_storage_path, extracted_text: args.p_extracted_text, content_hash: args.p_content_hash,
        revision: 1, is_active: true,
      };
      return { data: document, error: null };
    } };
  };

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
  assert.equal(releaseCalls, 0, "an ambiguous publication response must retain its claim lease");
  intentExpired = true;
  let cleanupStatus = 0;
  let cleanupBody: any;
  const cleanupResponse: any = {
    status: (value: number) => { cleanupStatus = value; return cleanupResponse; },
    json: (value: any) => { cleanupBody = value; return cleanupResponse; },
  };
  await cleanupCandidateDocumentUploads({ headers: { authorization: "Bearer synthetic-cron-secret" } } as any, cleanupResponse);
  assert.equal(cleanupStatus, 200);
  assert.equal(cleanupBody.data.examined, 0, "cleanup must not claim an expired upload with an ambiguous active finalization");
  assert.equal(cleanupRemovalCalls, 0);
  const immediateRetry = await run();
  assert.equal(immediateRetry.status, 409, "concurrent or ambiguous finalization remains protected during its lease");
  finalizationLeaseActive = false; // Simulate reclaim after the persisted lease expires.
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
  let claimCalls = 0;
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
  (supabaseAdmin as any).rpc = (name: string, args: any) => {
    if (name === "claim_candidate_document_upload_finalization") {
      claimCalls++;
      return Promise.resolve({ data: claimCalls === 1 ? "claimed" : "busy", error: null });
    }
    if (name === "release_candidate_document_upload_finalization") return Promise.resolve({ data: true, error: null });
    assert.equal(name, "complete_candidate_document_upload_finalization");
    return { single: async () => {
      rpcCalls++;
      const row = {
        id: args.p_id, user_id: args.p_user_id, document_type: args.p_document_type, filename: args.p_filename,
        storage_path: args.p_storage_path, extracted_text: args.p_extracted_text, content_hash: args.p_content_hash,
        revision: 1, is_active: true,
      };
      document = row;
      return { data: row, error: null };
    } };
  };

  const run = async () => {
    let status = 0;
    let body: any;
    const response: any = { status: (value: number) => { status = value; return response; }, json: (value: any) => { body = value; return response; } };
    await finalizeCandidateDocumentUpload({ auth: { userId: "owner-a" }, body: { uploadId, documentType: "cv", filename: "same.md" } } as any, response);
    return { status, body };
  };
  const results = await Promise.all([run(), run()]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(results.find(result => result.status === 201)?.body.data.id, uploadId);
  assert.equal(rpcCalls, 1);
  const retried = await run();
  assert.equal(retried.status, 201, "a later retry reads the committed winner idempotently");
});
