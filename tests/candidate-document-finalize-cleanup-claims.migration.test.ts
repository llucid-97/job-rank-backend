import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const documentsFixture = new URL("./fixtures/candidate-documents.sql", import.meta.url);
const replaceMigration = new URL("../supabase/migrations/20260926162109_replace_candidate_document_atomic.sql", import.meta.url);
const uploadMigration = new URL("../supabase/migrations/20261030170000_bound_candidate_upload_intents_and_finalize_retries.sql", import.meta.url);
const claimMigration = new URL("../supabase/migrations/20261030190000_claim_candidate_upload_finalize_cleanup.sql", import.meta.url);

test("finalization and cleanup claims are mutually exclusive and preserve atomic publication", async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(documentsFixture, "utf8"));
    await db.exec(await readFile(replaceMigration, "utf8"));
    await db.exec(`
      create table public.candidate_document_upload_intents (
        id uuid primary key, user_id uuid not null, purge_after timestamptz not null,
        created_at timestamptz not null default now()
      );
      grant select, insert, update, delete on public.candidate_document_upload_intents to service_role;
    `);
    await db.exec(await readFile(uploadMigration, "utf8"));
    await db.exec(await readFile(claimMigration, "utf8"));
    await db.exec("set role service_role");

    const owner = "00000000-0000-0000-0000-000000000001";
    const upload = "20000000-0000-0000-0000-000000000001";
    const finalPath = `${owner}/${upload}/document.md`;
    const finalizeTokens = [
      "30000000-0000-0000-0000-000000000001",
      "30000000-0000-0000-0000-000000000002",
    ];
    await db.query(
      "insert into public.candidate_document_upload_intents(id,user_id,purge_after) values ($1,$2,now()+interval '2 seconds')",
      [upload, owner],
    );

    const concurrentClaims = await Promise.all(finalizeTokens.map(token => db.query(
      "select public.claim_candidate_document_upload_finalization($1,$2,$3,$4) as status",
      [upload, owner, token, finalPath],
    )));
    assert.deepEqual(concurrentClaims.map(result => result.rows[0].status).sort(), ["busy", "claimed"]);
    const winnerToken = finalizeTokens[concurrentClaims.findIndex(result => result.rows[0].status === "claimed")]!;
    const lease = await db.query(
      "select extract(epoch from (finalize_claim_until - clock_timestamp())) * 1000 as remaining_ms from public.candidate_document_upload_intents where id=$1",
      [upload],
    );
    assert.ok(Number(lease.rows[0].remaining_ms) > 120_000, "finalization lease outlives the 120-second function ceiling");

    // Falsify the original race: the intent expires after finalization claims
    // it but before the PDF/Markdown work and publication finish.
    await db.query("update public.candidate_document_upload_intents set purge_after=now()-interval '1 second' where id=$1", [upload]);
    const cleanupWhileFinalizing = await db.query(
      "select * from public.claim_candidate_document_uploads_for_cleanup($1,100)",
      ["40000000-0000-0000-0000-000000000001"],
    );
    assert.equal(cleanupWhileFinalizing.rows.length, 0, "cleanup cannot claim an active finalizer even after expiry");

    const published = await db.query(
      "select (public.complete_candidate_document_upload_finalization($1,$2,'cv','resume.md',$3,'Synthetic CV','hash',$4)).id as id",
      [upload, owner, finalPath, winnerToken],
    );
    assert.equal(published.rows[0].id, upload);
    const cleanupAfterCommit = await db.query(
      "select * from public.claim_candidate_document_uploads_for_cleanup($1,100)",
      ["40000000-0000-0000-0000-000000000002"],
    );
    assert.deepEqual(cleanupAfterCommit.rows.map(row => row.final_storage_path), [finalPath]);
    const cleanupLease = await db.query(
      "select extract(epoch from (cleanup_claim_until - clock_timestamp())) * 1000 as remaining_ms from public.candidate_document_upload_intents where id=$1",
      [upload],
    );
    assert.ok(Number(cleanupLease.rows[0].remaining_ms) > 120_000, "cleanup lease outlives the 90-second cleanup budget");
    assert.equal((await db.query(
      "select count(*)::int as count from public.candidate_documents where id=$1 and storage_path=$2",
      [upload, finalPath],
    )).rows[0].count, 1, "the object path remains referenced after atomic publication");
    await db.query(
      "update public.candidate_document_upload_intents set cleanup_claim_until=now()-interval '1 second' where id=$1",
      [upload],
    );
    const reclaimedCleanup = await db.query(
      "select * from public.claim_candidate_document_uploads_for_cleanup($1,100)",
      ["40000000-0000-0000-0000-000000000005"],
    );
    assert.equal(reclaimedCleanup.rows[0].id, upload, "a terminated cleanup can be reclaimed after its lease expires");

    const secondUpload = "20000000-0000-0000-0000-000000000002";
    const secondFinalPath = `${owner}/${secondUpload}/document.md`;
    const staleToken = "30000000-0000-0000-0000-000000000003";
    await db.query(
      "insert into public.candidate_document_upload_intents(id,user_id,purge_after) values ($1,$2,now()+interval '1 hour')",
      [secondUpload, owner],
    );
    assert.equal((await db.query(
      "select public.claim_candidate_document_upload_finalization($1,$2,$3,$4) as status",
      [secondUpload, owner, staleToken, secondFinalPath],
    )).rows[0].status, "claimed");

    // A terminated invocation becomes reclaimable only after its lease expires.
    await db.query(
      "update public.candidate_document_upload_intents set purge_after=now()-interval '1 second', finalize_claim_until=now()-interval '1 second' where id=$1",
      [secondUpload],
    );
    const cleanupOwnsExpiredLease = await db.query(
      "select * from public.claim_candidate_document_uploads_for_cleanup($1,100)",
      ["40000000-0000-0000-0000-000000000003"],
    );
    assert.equal(cleanupOwnsExpiredLease.rows[0].id, secondUpload);
    assert.equal((await db.query(
      "select public.claim_candidate_document_upload_finalization($1,$2,$3,$4) as status",
      [secondUpload, owner, "30000000-0000-0000-0000-000000000004", secondFinalPath],
    )).rows[0].status, "expired", "expired intents remain rejected even after cleanup owns the lease");
    await assert.rejects(() => db.query(
      "select public.complete_candidate_document_upload_finalization($1,$2,'cv','late.md',$3,'Late CV','late-hash',$4)",
      [secondUpload, owner, secondFinalPath, staleToken],
    ), error => error.code === "P0001");
    assert.equal((await db.query(
      "select public.delete_candidate_document_uploads_after_cleanup($1,$2::uuid[]) as count",
      ["40000000-0000-0000-0000-000000000003", [secondUpload]],
    )).rows[0].count, 1);
    assert.equal((await db.query(
      "select count(*)::int as count from public.candidate_document_upload_intents where id=$1",
      [secondUpload],
    )).rows[0].count, 0);

    await db.exec("reset role; set role authenticated");
    await assert.rejects(() => db.query(
      "select public.claim_candidate_document_uploads_for_cleanup($1,100)",
      ["40000000-0000-0000-0000-000000000004"],
    ), error => error.code === "42501");
  } finally {
    await db.close();
  }
});
