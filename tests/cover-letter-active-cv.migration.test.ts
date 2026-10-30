import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL(
  "../supabase/migrations/20261030220000_guard_cover_letter_cv_publication.sql",
  import.meta.url,
);

test("cover letter publication atomically requires the owner's active CV and matching profile", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.candidate_documents (
        id uuid primary key, user_id uuid not null, document_type text not null,
        is_active boolean not null
      );
      create table public.candidate_profiles (
        id uuid primary key, user_id uuid not null, cv_document_id uuid not null
      );
      create table public.generated_documents (
        id uuid primary key default gen_random_uuid(), user_id uuid not null,
        job_id uuid not null, candidate_profile_id uuid not null,
        document_type text not null, content text not null, model text not null,
        prompt_version text not null
      );
      grant usage on schema public to anon, authenticated, service_role;
      grant select, update on public.candidate_documents to service_role;
      grant select, update on public.candidate_profiles to service_role;
      grant select, insert on public.generated_documents to service_role;
    `);
    await db.exec(await readFile(migration, "utf8"));
    await db.exec(`
      insert into public.candidate_documents values
        ('00000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','cv',true),
        ('00000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','cv',true);
      insert into public.candidate_profiles values
        ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001'),
        ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002');
    `);
    await db.exec("set role service_role");

    const params = [
      "10000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000001",
      "30000000-0000-0000-0000-000000000001",
      "40000000-0000-0000-0000-000000000001",
      "Letter", "model", "1.0.0",
    ];
    const published = await db.query(
      "select (public.publish_cover_letter_for_active_cv($1,$2,$3,$4,$5,$6,$7)).document_type as document_type",
      params,
    );
    assert.equal(published.rows[0].document_type, "cover_letter");

    await db.query("update public.candidate_documents set is_active=false where id=$1", [params[1]]);
    await assert.rejects(
      () => db.query(
        "select public.publish_cover_letter_for_active_cv($1,$2,$3,$4,$5,$6,$7)",
        [ ...params.slice(0, 6), "1.0.0" ],
      ),
      error => error.code === "P0001",
    );
    assert.equal((await db.query("select count(*)::int as count from public.generated_documents")).rows[0].count, 1);

    await db.exec("reset role");
    const grants = await db.query(`
      select has_function_privilege('service_role', 'public.publish_cover_letter_for_active_cv(uuid,uuid,uuid,uuid,text,text,text)', 'execute') as service_can_publish,
             has_function_privilege('authenticated', 'public.publish_cover_letter_for_active_cv(uuid,uuid,uuid,uuid,text,text,text)', 'execute') as user_can_publish
    `);
    assert.deepEqual(grants.rows[0], { service_can_publish: true, user_can_publish: false });
  } finally {
    await db.close();
  }
});
