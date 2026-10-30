import { test } from "node:test";
import assert from "node:assert/strict";

test("direct finalization maps parser resource limits to 413 and malformed DOCX to 422", async () => {
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

  const [{ mapFinalizationDocumentError }, { DocxResourceLimitError, UnsafeDocumentError }, { PdfResourceLimitError }] = await Promise.all([
    import("../src/modules/candidate/candidate.controller.ts"),
    import("../src/modules/candidate/docx-limits.ts"),
    import("../src/modules/candidate/pdf-resource-limit.ts"),
  ]);

  assert.equal(mapFinalizationDocumentError(new PdfResourceLimitError()).status, 413);
  assert.equal(mapFinalizationDocumentError(new DocxResourceLimitError()).status, 413);
  assert.equal(mapFinalizationDocumentError(new UnsafeDocumentError()).status, 422);
  assert.equal(mapFinalizationDocumentError(new Error("storage unavailable")), null);
});
