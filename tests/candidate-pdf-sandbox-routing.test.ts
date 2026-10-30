import { test } from "node:test";
import assert from "node:assert/strict";

test("both PDF upload paths fail closed through Sandbox when no parser snapshot is configured", async () => {
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
    PDF_SANDBOX_SNAPSHOT_ID: "",
  });

  const [{ supabaseAdmin }, { finalizeCandidateDocumentUpload, uploadCandidateDocument }] = await Promise.all([
    import("../src/config/supabase.ts"),
    import("../src/modules/candidate/candidate.controller.ts"),
  ]);
  const uploadId = "11111111-1111-4111-8111-111111111111";
  const pdf = Buffer.from("%PDF-1.7\nsynthetic fixture");
  let destinationUploads = 0;
  (supabaseAdmin as any).rpc = (name: string) => {
    if (name === "claim_candidate_document_upload_finalization") return Promise.resolve({ data: "claimed", error: null });
    if (name === "release_candidate_document_upload_finalization") return Promise.resolve({ data: true, error: null });
    throw new Error(`Unexpected RPC ${name}`);
  };
  (supabaseAdmin as any).from = (table: string) => {
    if (table === "candidate_documents") {
      return {
        select: () => ({
          eq: function () { return this; },
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      };
    }
    assert.equal(table, "candidate_document_upload_intents");
    return {
      select: () => ({
        eq: function () { return this; },
        maybeSingle: async () => ({ data: { id: uploadId, purge_after: new Date(Date.now() + 60_000).toISOString() }, error: null }),
      }),
    };
  };
  (supabaseAdmin as any).storage.from = (bucket: string) => {
    if (bucket === "candidate-document-staging") {
      return { download: async () => ({ data: new Blob([pdf]), error: null }) };
    }
    return {
      upload: async () => { destinationUploads++; return { error: null }; },
      remove: async () => ({ error: null }),
    };
  };

  const invoke = async (handler: Function, request: unknown) => {
    let status = 0;
    let body: any;
    const response: any = {
      status: (value: number) => { status = value; return response; },
      json: (value: any) => { body = value; return response; },
    };
    await handler(request, response);
    return { status, body };
  };

  const finalized = await invoke(finalizeCandidateDocumentUpload, {
    auth: { userId: "owner-a" },
    body: { uploadId, documentType: "cv", filename: "resume.pdf" },
  });
  assert.equal(finalized.status, 503);
  assert.equal(finalized.body.error.code, "PDF_EXTRACTION_UNAVAILABLE");

  const legacy = await invoke(uploadCandidateDocument, {
    auth: { userId: "owner-a" },
    body: { documentType: "cv" },
    file: { originalname: "resume.pdf", mimetype: "application/pdf", buffer: pdf },
  });
  assert.equal(legacy.status, 503);
  assert.equal(legacy.body.error.code, "PDF_EXTRACTION_UNAVAILABLE");
  assert.equal(destinationUploads, 0);

  const { extractDocumentText } = await import("../src/modules/candidate/document_text.service.ts");
  let sandboxCalls = 0;
  const neverSandbox = async () => { sandboxCalls++; throw new Error("text files must stay local"); };
  assert.equal(await extractDocumentText(Buffer.from("local text"), "text/plain", { extractPdf: neverSandbox as any }), "local text");
  assert.equal(sandboxCalls, 0);
});
