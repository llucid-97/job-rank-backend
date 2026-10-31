import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const documentsFixture = new URL("./fixtures/candidate-documents.sql", import.meta.url);
const replaceMigration = new URL("../supabase/migrations/20260926162109_replace_candidate_document_atomic.sql", import.meta.url);
const uploadMigration = new URL("../supabase/migrations/20261030170000_bound_candidate_upload_intents_and_finalize_retries.sql", import.meta.url);
const claimMigration = new URL("../supabase/migrations/20261030190000_claim_candidate_upload_finalize_cleanup.sql", import.meta.url);
const retirementMigration = new URL("../supabase/migrations/20261031120000_retire_finalized_candidate_upload_staging.sql", import.meta.url);

function uuid(index: number) {
  return `20000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
}

test("finalized uploads free pending capacity but retain cleanup tombstones", async () => {
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
    await db.exec(await readFile(retirementMigration, "utf8"));
    await db.exec("set role service_role");

    const owner = "00000000-0000-0000-0000-000000000001";
    const upload = uuid(1);
    const finalPath = `${owner}/${upload}/document.md`;
    const finalizeToken = "30000000-0000-0000-0000-000000000001";
    const retireToken = "40000000-0000-0000-0000-000000000001";
    await db.query(
      "insert into public.candidate_document_upload_intents(id,user_id,purge_after) values ($1,$2,now()+interval '3 hours')",
      [upload, owner],
    );
    assert.equal((await db.query(
      "select public.claim_candidate_document_upload_finalization($1,$2,$3,$4) as status",
      [upload, owner, finalizeToken, finalPath],
    )).rows[0].status, "claimed");
    const published = await db.query(
      "select (public.complete_candidate_document_upload_finalization($1,$2,'cv','resume.md',$3,'Synthetic CV','hash',$4)).id as id",
      [upload, owner, finalPath, finalizeToken],
    );
    assert.equal(published.rows[0].id, upload);
    const tombstone = await db.query(
      "select finalized_at is not null as finalized, purge_after > clock_timestamp() as retained_for_signed_token from public.candidate_document_upload_intents where id=$1",
      [upload],
    );
    assert.equal(tombstone.rows[0].finalized, true);
    assert.equal(tombstone.rows[0].retained_for_signed_token, true);

    assert.equal((await db.query(
      "select public.claim_finalized_candidate_document_upload_retirement($1,$2,$3) as status",
      [upload, owner, retireToken],
    )).rows[0].status, "claimed");
    // Simulate expiry passing while immediate retirement holds the shared cleanup lease.
    await db.query(
      "update public.candidate_document_upload_intents set purge_after=clock_timestamp()-interval '1 second' where id=$1",
      [upload],
    );
    assert.equal((await db.query(
      "select * from public.claim_candidate_document_uploads_for_cleanup($1,100)",
      ["50000000-0000-0000-0000-000000000001"],
    )).rows.length, 0, "an immediate source removal lease excludes the scheduled cleaner");
    assert.equal((await db.query(
      "select public.release_candidate_document_upload_cleanup($1,$2::uuid[]) as count",
      [retireToken, [upload]],
    )).rows[0].count, 1);
    assert.equal((await db.query(
      "select count(*)::int as count from public.candidate_document_upload_intents where id=$1",
      [upload],
    )).rows[0].count, 1, "the intent remains to catch a replayed signed upload");
    assert.equal((await db.query(
      "select count(*)::int as count from public.candidate_documents where id=$1 and storage_path=$2",
      [upload, finalPath],
    )).rows[0].count, 1, "source cleanup never removes published Markdown");
    const afterLease = await db.query(
      "select * from public.claim_candidate_document_uploads_for_cleanup($1,100)",
      ["50000000-0000-0000-0000-000000000003"],
    );
    assert.equal(afterLease.rows.some(row => row.id === upload), true, "cron can claim the tombstone after the immediate lease releases");
    assert.equal((await db.query(
      "select public.delete_candidate_document_uploads_after_cleanup($1,$2::uuid[]) as count",
      ["50000000-0000-0000-0000-000000000003", [upload]],
    )).rows[0].count, 1);

    // Fill five pending slots, then prove the finalized tombstone does not consume one.
    for (let index = 2; index <= 6; index++) {
      assert.equal((await db.query(
        "select public.create_candidate_document_upload_intent($1,$2,now()+interval '3 hours') as created",
        [uuid(index), owner],
      )).rows[0].created, true);
    }
    assert.equal((await db.query(
      "select public.create_candidate_document_upload_intent($1,$2,now()+interval '3 hours') as created",
      [uuid(7), owner],
    )).rows[0].created, false);
    await db.query(
      "update public.candidate_document_upload_intents set finalized_at=clock_timestamp() where id=$1",
      [uuid(2)],
    );
    assert.equal((await db.query(
      "select public.create_candidate_document_upload_intent($1,$2,now()+interval '3 hours') as created",
      [uuid(8), owner],
    )).rows[0].created, true, "a newly finalized upload frees a pending slot");

    // Successful starts still have a generous owner-scoped rolling hourly cap.
    const secondOwner = "00000000-0000-0000-0000-000000000002";
    for (let index = 100; index < 129; index++) {
      const id = uuid(index);
      assert.equal((await db.query(
        "select public.create_candidate_document_upload_intent($1,$2,now()+interval '3 hours') as created",
        [id, secondOwner],
      )).rows[0].created, true);
      await db.query(
        "update public.candidate_document_upload_intents set finalized_at=clock_timestamp() where id=$1",
        [id],
      );
    }
    const thirtieth = uuid(129);
    assert.equal((await db.query(
      "select public.create_candidate_document_upload_intent($1,$2,now()+interval '3 hours') as created",
      [thirtieth, secondOwner],
    )).rows[0].created, true);
    await db.query(
      "update public.candidate_document_upload_intents set finalized_at=clock_timestamp() where id=$1",
      [thirtieth],
    );
    assert.equal((await db.query(
      "select public.create_candidate_document_upload_intent($1,$2,now()+interval '3 hours') as created",
      [uuid(130), secondOwner],
    )).rows[0].created, false, "the 31st start in an hour is denied");
    await db.query(
      "update public.candidate_document_upload_intents set created_at=clock_timestamp()-interval '61 minutes' where user_id=$1",
      [secondOwner],
    );
    assert.equal((await db.query(
      "select public.create_candidate_document_upload_intent($1,$2,now()+interval '3 hours') as created",
      [uuid(131), secondOwner],
    )).rows[0].created, true, "the rolling limit resets after the window");

    // The cron and immediate cleanup claims share one lease.
    const cronUpload = uuid(9);
    await db.query(
      "insert into public.candidate_document_upload_intents(id,user_id,purge_after,finalized_at) values ($1,$2,now()-interval '1 second',clock_timestamp())",
      [cronUpload, owner],
    );
    const cronToken = "50000000-0000-0000-0000-000000000002";
    const cleanup = await db.query(
      "select * from public.claim_candidate_document_uploads_for_cleanup($1,100)",
      [cronToken],
    );
    assert.equal(cleanup.rows.some(row => row.id === cronUpload), true);
    assert.equal((await db.query(
      "select public.claim_finalized_candidate_document_upload_retirement($1,$2,$3) as status",
      [cronUpload, owner, "40000000-0000-0000-0000-000000000003"],
    )).rows[0].status, "busy", "immediate retirement does not race a cron cleanup claim");

    const unfinished = uuid(10);
    await db.query(
      "insert into public.candidate_document_upload_intents(id,user_id,purge_after) values ($1,$2,now()+interval '3 hours')",
      [unfinished, owner],
    );
    assert.equal((await db.query(
      "select public.claim_finalized_candidate_document_upload_retirement($1,$2,$3) as status",
      [unfinished, owner, "40000000-0000-0000-0000-000000000004"],
    )).rows[0].status, "not_finalized");

    await db.exec("reset role");
    const permissions = await db.query(`
      select
        has_function_privilege('service_role', 'public.claim_finalized_candidate_document_upload_retirement(uuid,uuid,uuid)', 'execute') as service_can_claim,
        has_function_privilege('anon', 'public.claim_finalized_candidate_document_upload_retirement(uuid,uuid,uuid)', 'execute') as anon_can_claim,
        has_function_privilege('authenticated', 'public.claim_finalized_candidate_document_upload_retirement(uuid,uuid,uuid)', 'execute') as authenticated_can_claim,
        has_function_privilege('service_role', 'public.create_candidate_document_upload_intent(uuid,uuid,timestamp with time zone)', 'execute') as service_can_start,
        has_function_privilege('authenticated', 'public.create_candidate_document_upload_intent(uuid,uuid,timestamp with time zone)', 'execute') as authenticated_can_start
    `);
    assert.deepEqual(permissions.rows[0], {
      service_can_claim: true,
      anon_can_claim: false,
      authenticated_can_claim: false,
      service_can_start: true,
      authenticated_can_start: false,
    });
  } finally {
    await db.close();
  }
});
