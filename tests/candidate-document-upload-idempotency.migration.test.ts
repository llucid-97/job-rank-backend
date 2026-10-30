import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const documentsFixture = new URL("./fixtures/candidate-documents.sql", import.meta.url);
const replacementMigration = new URL("../supabase/migrations/20260926162109_replace_candidate_document_atomic.sql", import.meta.url);
const uploadMigration = new URL("../supabase/migrations/20261030170000_bound_candidate_upload_intents_and_finalize_retries.sql", import.meta.url);

test("upload intents are capped per owner and document publication is idempotent by upload UUID", async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(documentsFixture, "utf8"));
    await db.exec(await readFile(replacementMigration, "utf8"));
    await db.exec(`
      create table public.candidate_document_upload_intents (
        id uuid primary key, user_id uuid not null, purge_after timestamptz not null,
        created_at timestamptz not null default now()
      );
      grant select, insert, delete on public.candidate_document_upload_intents to service_role;
    `);
    await db.exec(await readFile(uploadMigration, "utf8"));
    await db.exec("set role service_role");

    const owner = "00000000-0000-0000-0000-000000000001";
    const intentIds = Array.from({ length: 8 }, (_, index) => `20000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`);
    const quotaResults = await Promise.all(intentIds.map(id => db.query(
      "select public.create_candidate_document_upload_intent($1::uuid, $2::uuid, now() + interval '3 hours') as created",
      [id, owner],
    )));
    assert.equal(quotaResults.filter(result => result.rows[0].created === true).length, 5);
    assert.equal(quotaResults.filter(result => result.rows[0].created === false).length, 3);

    const documentId = "30000000-0000-0000-0000-000000000001";
    const publish = () => db.query(
      "select (public.replace_candidate_document($1,$2,$3,$4,$5,$6,$7)).*",
      [documentId, owner, "cv", "resume.md", `${owner}/${documentId}/resume.md`, "Synthetic CV", "synthetic-hash"],
    );
    const results = await Promise.all([publish(), publish()]);
    assert.deepEqual(results.map(result => result.rows[0].revision), [1, 1]);
    assert.equal((await db.query("select count(*)::int as count from public.candidate_documents where id=$1", [documentId])).rows[0].count, 1);
    await assert.rejects(
      () => db.query(
        "select public.replace_candidate_document($1,$2,$3,$4,$5,$6,$7)",
        [documentId, owner, "cv", "different.md", `${owner}/${documentId}/different.md`, "Different CV", "different-hash"],
      ),
      error => error.code === "P0001",
    );
  } finally {
    await db.close();
  }
});
