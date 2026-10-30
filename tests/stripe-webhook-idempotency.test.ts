import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

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
  SKILLS_JSON_GENERATION_MODEL: "synthetic-model",
  COVER_LETTER_CODEX_MODEL: "synthetic-model",
});

const { supabaseAdmin } = await import("../src/config/supabase.js");
const { beginWebhookEvent } = await import(
  "../src/modules/billing/stripe-webhook.service.js"
);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);

afterEach(() => {
  supabaseAdmin.rpc = originalRpc as typeof supabaseAdmin.rpc;
});

/** Force both retry handlers to enter the same failed-event claim simultaneously. */
function installConcurrentRetryDatabase() {
  let eventRow: Record<string, any> = {
    stripe_event_id: "evt-synthetic",
    processing_status: "failed",
    processing_attempts: 1,
  };
  let attempts = 0;
  let releaseAttempts!: () => void;
  const bothAttempts = new Promise<void>((resolve) => {
    releaseAttempts = resolve;
  });

  // Both callers reach the database claim together; its transaction orders the row transition.
  supabaseAdmin.rpc = (async (name: string, args: Record<string, any>) => {
    assert.equal(name, "claim_stripe_webhook_event");
    assert.equal(args.p_event_id, "evt-synthetic");
    if (++attempts === 2) releaseAttempts();
    await bothAttempts;

    if (eventRow.processing_status === "failed") {
      eventRow = {
        ...eventRow,
        processing_status: "processing",
        processing_attempts: eventRow.processing_attempts + 1,
        processing_claim_token: args.p_claim_token,
      };
      return { data: "claimed", error: null };
    }
    return { data: "busy", error: null };
  }) as typeof supabaseAdmin.rpc;

  return () => eventRow;
}

test("only one concurrent retry claims a failed Stripe event", async () => {
  const currentRow = installConcurrentRetryDatabase();
  const event = {
    id: "evt-synthetic",
    type: "customer.subscription.updated",
    livemode: false,
    api_version: "2026-10-28",
    data: { object: { id: "sub-synthetic" } },
  } as any;

  const claims = await Promise.allSettled([
    beginWebhookEvent(event),
    beginWebhookEvent(event),
  ]);

  assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
  const rejected = claims.find((claim) => claim.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.statusCode, 503);
  assert.equal(currentRow().processing_status, "processing");
  assert.equal(currentRow().processing_attempts, 2);
});
