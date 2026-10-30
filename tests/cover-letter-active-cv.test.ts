import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { supabaseAdmin } from "../src/config/supabase.js";
import { AppError } from "../src/middleware/error-handling.js";
import { generateCoverLetter } from "../src/modules/cover-letter/cover-letter.service.js";

const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalFetch = globalThis.fetch;

afterEach(() => {
  supabaseAdmin.rpc = originalRpc as any;
  supabaseAdmin.from = originalFrom as any;
  globalThis.fetch = originalFetch;
});

test("cover letter publication rejects a CV replaced while the provider is running", async () => {
  let cvIsActive = true;
  let providerStarted!: () => void;
  let resumeProvider!: () => void;
  const started = new Promise<void>(resolve => { providerStarted = resolve; });
  const providerGate = new Promise<void>(resolve => { resumeProvider = resolve; });
  const rpcNames: string[] = [];
  let documentReads = 0;

  const selected = (data: unknown) => {
    const builder: any = {
      select() { return this; },
      eq() { return this; },
      order() { return this; },
      limit() { return this; },
      maybeSingle: async () => ({ data, error: null }),
    };
    return builder;
  };

  supabaseAdmin.from = ((table: string) => {
    if (table === "user_jobs") return selected({ job_id: "job-1", workspace_data: null });
    if (table === "jobs") {
      const builder = selected({ id: "job-1", title: "Engineer", company_name: "Acme", description: "Build things", location: "Remote" });
      builder.single = async () => ({ data: { id: "job-1", title: "Engineer", company_name: "Acme", description: "Build things", location: "Remote" }, error: null });
      return builder;
    }
    if (table === "candidate_documents") {
      // The first lookup is the CV; the second is the optional About You file.
      const currentRead = documentReads++;
      return selected(currentRead === 0 ? { id: "cv-old", extracted_text: "Old CV", is_active: cvIsActive } : null);
    }
    if (table === "candidate_profiles") return selected({ id: "profile-old", skills_profile: { skills: [] } });
    if (table === "job_rankings") return selected(null);
    throw new Error(`Unexpected table ${table}`);
  }) as any;

  supabaseAdmin.rpc = ((name: string) => {
    rpcNames.push(name);
    if (name === "consume_provider_quota") return Promise.resolve({ data: true, error: null });
    assert.equal(name, "publish_cover_letter_for_active_cv");
    return {
      single: async () => cvIsActive
        ? { data: { id: "generated-1" }, error: null }
        : { data: null, error: { code: "P0001" } },
    };
  }) as any;

  globalThis.fetch = (async () => {
    providerStarted();
    await providerGate;
    return new Response(JSON.stringify({ choices: [{ message: { content: "Letter based on old CV" } }] }));
  }) as typeof fetch;

  const generation = generateCoverLetter({ userId: "owner-1", jobId: "job-1", tone: "professional" });
  await started;
  // Simulate replacement during the provider wait, before atomic publication.
  cvIsActive = false;
  resumeProvider();

  await assert.rejects(generation, (error: unknown) =>
    error instanceof AppError && error.statusCode === 409 && error.code === "CANDIDATE_CONTEXT_CHANGED",
  );
  assert.deepEqual(rpcNames, ["consume_provider_quota", "publish_cover_letter_for_active_cv"]);
});
