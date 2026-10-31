import { randomUUID } from "node:crypto";

export type CandidateUploadRetirementClaim =
  | "claimed"
  | "not_found"
  | "not_finalized"
  | "busy";

export type CandidateUploadRetirementResult =
  | { ok: true; alreadyRetired?: true; deferred?: true }
  | { ok: false; stage: "claim" | "source" | "release"; error?: unknown };

/** Remove staged bytes under the cleanup lease while retaining the signed-token tombstone. */
export async function retireFinalizedCandidateDocumentStaging(
  input: { userId: string; uploadId: string; sourcePath: string },
  dependencies: {
    claim: (
      userId: string,
      uploadId: string,
      claimToken: string,
    ) => Promise<CandidateUploadRetirementClaim>;
    removeSource: (
      sourcePath: string,
    ) => Promise<{ error: unknown | null }>;
    releaseClaim: (
      userId: string,
      uploadId: string,
      claimToken: string,
    ) => Promise<unknown>;
  },
): Promise<CandidateUploadRetirementResult> {
  const claimToken = randomUUID();
  let claim: CandidateUploadRetirementClaim;
  try {
    claim = await dependencies.claim(input.userId, input.uploadId, claimToken);
  } catch (error) {
    return { ok: false, stage: "claim", error };
  }

  // The existing cleaner removes the source before deleting an intent.
  if (claim === "not_found") return { ok: true, alreadyRetired: true };
  if (claim === "busy" || claim === "not_finalized") {
    return { ok: true, deferred: true };
  }
  if (claim !== "claimed") return { ok: false, stage: "claim" };

  try {
    const { error } = await dependencies.removeSource(input.sourcePath);
    if (error) {
      await dependencies.releaseClaim(input.userId, input.uploadId, claimToken).catch(() => undefined);
      return { ok: false, stage: "source", error };
    }
    // Storage remove is idempotent: an empty result means the source was already absent.
  } catch (error) {
    await dependencies.releaseClaim(input.userId, input.uploadId, claimToken).catch(() => undefined);
    return { ok: false, stage: "source", error };
  }

  try {
    // Keep the finalized intent as a replay tombstone through its original purge_after.
    await dependencies.releaseClaim(input.userId, input.uploadId, claimToken);
    return { ok: true };
  } catch (error) {
    // The five-minute claim expires automatically; scheduled cleanup remains the final fallback.
    return { ok: false, stage: "release", error };
  }
}
