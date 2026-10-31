import assert from "node:assert/strict";
import { test } from "node:test";
import { retireFinalizedCandidateDocumentStaging } from "../src/modules/candidate/candidate-document-staging-retirement.js";

const input = {
  userId: "00000000-0000-4000-8000-000000000001",
  uploadId: "11111111-1111-4111-8111-111111111111",
  sourcePath: "00000000-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111/source",
};

test("retirement removes staged bytes under a claim and releases the tombstone", async () => {
  const events: string[] = [];
  const result = await retireFinalizedCandidateDocumentStaging(input, {
    claim: async (_user, _id, token) => {
      assert.match(token, /^[0-9a-f-]{36}$/i);
      events.push("claim");
      return "claimed";
    },
    removeSource: async path => {
      assert.equal(path, input.sourcePath);
      events.push("remove-source");
      return { error: null };
    },
    releaseClaim: async () => {
      events.push("release-claim");
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, ["claim", "remove-source", "release-claim"]);
});

test("an already missing source is safe to remove idempotently", async () => {
  const events: string[] = [];
  const result = await retireFinalizedCandidateDocumentStaging(input, {
    claim: async () => "claimed",
    // Supabase Storage remove returns an empty successful result for an absent path.
    removeSource: async () => {
      events.push("remove-source");
      return { error: null };
    },
    releaseClaim: async () => {
      events.push("release-claim");
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(events, ["remove-source", "release-claim"]);
});

test("source removal failure keeps the finalized tombstone for cron fallback", async () => {
  const events: string[] = [];
  const removalError = new Error("Synthetic storage failure");
  const result = await retireFinalizedCandidateDocumentStaging(input, {
    claim: async () => "claimed",
    removeSource: async () => {
      events.push("remove-source");
      return { error: removalError };
    },
    releaseClaim: async () => {
      events.push("release-claim");
    },
  });

  assert.deepEqual(result, { ok: false, stage: "source", error: removalError });
  assert.deepEqual(events, ["remove-source", "release-claim"]);
});

test("claim release failure leaves the five-minute claim to expire for cron recovery", async () => {
  const releaseError = new Error("Synthetic database failure");
  const result = await retireFinalizedCandidateDocumentStaging(input, {
    claim: async () => "claimed",
    removeSource: async () => ({ error: null }),
    releaseClaim: async () => {
      throw releaseError;
    },
  });

  assert.deepEqual(result, { ok: false, stage: "release", error: releaseError });
});

test("an idempotent retry after cron retirement does not need to remove again", async () => {
  const events: string[] = [];
  const result = await retireFinalizedCandidateDocumentStaging(input, {
    claim: async () => {
      events.push("claim");
      return "not_found";
    },
    removeSource: async () => {
      events.push("remove-source");
      return { error: null };
    },
    releaseClaim: async () => {
      events.push("release-claim");
    },
  });

  assert.deepEqual(result, { ok: true, alreadyRetired: true });
  assert.deepEqual(events, ["claim"]);
});

test("a concurrent cleanup claim prevents duplicate source removal", async () => {
  let removeCalls = 0;
  const result = await retireFinalizedCandidateDocumentStaging(input, {
    claim: async () => "busy",
    removeSource: async () => {
      removeCalls++;
      return { error: null };
    },
    releaseClaim: async () => undefined,
  });

  assert.deepEqual(result, { ok: true, deferred: true });
  assert.equal(removeCalls, 0);
});

test("a missing finalized row makes retry cleanup idempotent", async () => {
  const result = await retireFinalizedCandidateDocumentStaging(input, {
    claim: async () => "not_found",
    removeSource: async () => {
      throw new Error("No cleanup claim should be made for a retired intent.");
    },
    releaseClaim: async () => undefined,
  });

  assert.deepEqual(result, { ok: true, alreadyRetired: true });
});
