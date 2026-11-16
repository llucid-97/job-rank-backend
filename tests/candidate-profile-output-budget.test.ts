import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { supabaseAdmin } from "../src/config/supabase.js";
import { AppError } from "../src/middleware/error-handling.js";
import { generateCandidateProfile } from "../src/modules/candidate/candidate-profile.service.js";

const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalFetch = globalThis.fetch;
const syntheticDocument = {
  id: "synthetic-cv-id",
  user_id: "synthetic-user-id",
  document_type: "cv",
  extracted_text: "Synthetic CV text for an isolated output-budget test.",
  content_hash: "synthetic-content-hash",
};

afterEach(() => {
  supabaseAdmin.from = originalFrom as any;
  supabaseAdmin.rpc = originalRpc as any;
  globalThis.fetch = originalFetch;
});

/** Supply schema-valid synthetic evidence without copying any candidate material. */
function validProfile(longText = "Synthetic project evidence.") {
  return {
    skills_interests_schema: {
      skills: {},
      areas_of_interest: [longText],
    },
    behavioral_points_schema: {
      work_preferences: { project_types: [] },
    },
  };
}

/** Keep the integration seam realistic while forcing every database and provider call local. */
function installFakes(providerResponse: unknown) {
  let inserted: Record<string, unknown> | null = null;
  // Preserve the chained query shape while keeping every lookup inside this process.
  const builderFor = (table: string) => {
    const builder: any = {
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () => ({
        data: table === "candidate_documents" ? syntheticDocument : null,
        error: null,
      }),
    };
    // Capture only profile inserts so rejected completions can prove they publish nothing.
    if (table === "candidate_profiles") {
      builder.insert = (row: Record<string, unknown>) => {
        inserted = row;
        return {
          select() { return this; },
          single: async () => ({ data: { id: "synthetic-profile-id", ...row }, error: null }),
        };
      };
    }
    return builder;
  };

  supabaseAdmin.from = ((table: string) => builderFor(table)) as any;
  supabaseAdmin.rpc = (async () => ({ data: true, error: null })) as any;
  let providerCalls = 0;
  let requestBody: any;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    providerCalls++;
    assert.equal(String(input), "https://openrouter.ai/api/v1/chat/completions");
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(providerResponse), { status: 200 });
  }) as typeof fetch;
  return {
    get inserted() { return inserted; },
    get providerCalls() { return providerCalls; },
    get requestBody() { return requestBody; },
  };
}

/** Make direct service rejections assert the safe, structured API contract. */
async function rejectWithCode(promise: Promise<unknown>, code: string, message: string) {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof AppError &&
    error.statusCode === 502 &&
    error.code === code &&
    error.message === message,
  );
}

// Keep a single paid-operation boundary while admitting one complete synthetic profile.
test("requests the larger cap once and persists a valid synthetic profile", async () => {
  const largeEvidence = "Project evidence ".repeat(1_500);
  const output = installFakes({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(validProfile(largeEvidence)) } }],
  });

  const generated = await generateCandidateProfile("synthetic-user-id", "synthetic-cv-id");

  assert.equal(output.providerCalls, 1);
  assert.equal(output.requestBody.max_tokens, 8192);
  assert.equal(output.requestBody.model, process.env.SKILLS_JSON_GENERATION_MODEL);
  assert.equal(generated.generated, true);
  assert.deepEqual(generated.profile.skills_profile, validProfile(largeEvidence));
  assert.equal(output.inserted?.model, process.env.SKILLS_JSON_GENERATION_MODEL);
});

// A provider cutoff is incomplete even when the visible text happens to be valid JSON.
test("classifies length termination before empty or truncated content and never inserts", async () => {
  const cases = [
    { content: "", finish_reason: "length" },
    { content: "{\"skills_interests_schema\":", finish_reason: "length" },
    { content: JSON.stringify(validProfile()), finish_reason: "length" },
  ];

  // Never accept an incomplete completion merely because its visible JSON parses.
  for (const response of cases) {
    const output = installFakes({
      choices: [{ finish_reason: response.finish_reason, message: { content: response.content } }],
      usage: { completion_tokens: 8_192 },
    });

    await rejectWithCode(
      generateCandidateProfile("synthetic-user-id", "synthetic-cv-id"),
      "SKILLS_PROFILE_OUTPUT_LIMIT_REACHED",
      "Your CV is saved, but we couldn't finish the skills profile. Please try again.",
    );
    assert.equal(output.inserted, null);
  }
});

// Invalid completions must remain safe errors without publishing or logging private output.
test("maps empty, malformed, and schema-invalid completions to a safe 502", async () => {
  const invalidCode = "SKILLS_PROFILE_INVALID_RESPONSE";
  const invalidMessage = "Your CV is saved, but we couldn't create a usable skills profile. Please try again.";
  const cases = [
    { content: "", finish_reason: "stop" },
    { content: '{"provider_private_text":"SYNTHETIC_PRIVATE_OUTPUT"', finish_reason: "stop" },
    {
      content: JSON.stringify({
        skills_interests_schema: "SYNTHETIC_PRIVATE_PROFILE_VALUE",
        behavioral_points_schema: {},
      }),
      finish_reason: "stop",
    },
    null,
  ];

  // Exercise all malformed envelopes through the same public-error and no-insert contract.
  for (const response of cases) {
    const output = installFakes(response === null ? null : {
      choices: [{ finish_reason: response.finish_reason, message: { content: response.content } }],
    });
    const logs: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...values: unknown[]) => logs.push(JSON.stringify(values));
    // Inspect only synthetic logger output, then restore the original sink in every case.
    try {
      await rejectWithCode(
        generateCandidateProfile("synthetic-user-id", "synthetic-cv-id"),
        invalidCode,
        invalidMessage,
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(output.inserted, null);
    const safeLogs = logs.join(" ");
    assert.equal(safeLogs.includes("SYNTHETIC_PRIVATE"), false);
    if (safeLogs) {
      assert.equal(safeLogs.includes(invalidCode), true);
      assert.equal(safeLogs.includes("errorCount"), true);
    }
  }
});

