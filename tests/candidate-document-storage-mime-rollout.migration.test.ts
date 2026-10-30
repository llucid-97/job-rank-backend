import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const stagingMigration = new URL("../supabase/migrations/20261030103000_stage_candidate_document_uploads.sql", import.meta.url);
const stagingMarkdownMigration = new URL("../supabase/migrations/20261030180000_allow_markdown_staging_uploads.sql", import.meta.url);
const finalRestrictionMigration = new URL("../supabase/migrations/20261030200000_restrict_candidate_document_mime_types.sql", import.meta.url);

test("pre-deploy bucket MIME settings preserve legacy writers until the post-deploy restriction", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create role service_role nologin bypassrls;
      create schema storage;
      create table storage.buckets (
        id text primary key, name text not null, public boolean not null,
        file_size_limit bigint, allowed_mime_types text[]
      );
      create table storage.objects (id bigint primary key, bucket_id text not null);
      alter table storage.objects enable row level security;
      insert into storage.buckets values (
        'candidate-documents', 'candidate-documents', false, 4194304,
        array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain']
      );
    `);

    await db.exec(await readFile(stagingMigration, "utf8"));
    await db.exec(await readFile(stagingMarkdownMigration, "utf8"));
    const preDeploy = await db.query(
      "select allowed_mime_types from storage.buckets where id='candidate-documents'",
    );
    const compatibleTypes = preDeploy.rows[0].allowed_mime_types as string[];
    assert.deepEqual(compatibleTypes, [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
      "text/markdown",
    ]);
    const staging = await db.query(
      "select allowed_mime_types from storage.buckets where id='candidate-document-staging'",
    );
    assert.ok((staging.rows[0].allowed_mime_types as string[]).includes("text/markdown"));

    await db.exec(await readFile(finalRestrictionMigration, "utf8"));
    const postDeploy = await db.query(
      "select allowed_mime_types from storage.buckets where id='candidate-documents'",
    );
    assert.deepEqual(postDeploy.rows[0].allowed_mime_types, ["text/markdown", "text/plain"]);
  } finally {
    await db.close();
  }
});
