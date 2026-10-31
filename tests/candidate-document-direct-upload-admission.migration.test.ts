import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL(
  "../supabase/migrations/20261031110000_limit_legacy_candidate_upload_admission.sql",
  import.meta.url,
);

function uuid(value: number) {
  return `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
}

test("legacy upload admission serializes per-user rate and concurrency with service-only RPCs", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant select on auth.users to service_role;
      insert into auth.users(id) values ('${uuid(1)}'), ('${uuid(2)}');
    `);
    await db.exec(await readFile(migration, "utf8"));
    await db.exec("set role service_role");

    const acquire = (userId: string, requestId: string) => db.query(
      "select public.acquire_candidate_document_direct_upload($1::uuid, $2::uuid) as retry_after",
      [userId, requestId],
    );
    const release = (userId: string, requestId: string) => db.query(
      "select public.release_candidate_document_direct_upload($1::uuid, $2::uuid) as released",
      [userId, requestId],
    );

    const owner = uuid(1);
    const parallel = await Promise.all(
      Array.from({ length: 8 }, (_, index) => acquire(owner, uuid(100 + index))),
    );
    assert.equal(parallel.filter(result => result.rows[0].retry_after === 0).length, 3);
    const denied = parallel.find(result => result.rows[0].retry_after > 0)!;
    assert.ok(denied.rows[0].retry_after > 0 && denied.rows[0].retry_after <= 150);

    const activeIds = (await db.query(
      "select request_id from public.candidate_document_direct_upload_leases where user_id=$1 and lease_expires_at > clock_timestamp() order by request_id",
      [owner],
    )).rows.map(row => row.request_id as string);
    assert.equal(activeIds.length, 3);
    assert.equal((await release(owner, activeIds[0]!)).rows[0].released, true);
    assert.equal((await acquire(owner, uuid(200))).rows[0].retry_after, 0, "release frees an active slot immediately");
    await db.query(
      "update public.candidate_document_direct_upload_leases set lease_expires_at=clock_timestamp()-interval '1 second' where request_id=$1",
      [activeIds[1]],
    );
    assert.equal((await acquire(owner, uuid(201))).rows[0].retry_after, 0, "an abandoned active slot recovers after lease expiry");

    await db.query(
      "update public.candidate_document_direct_upload_leases set lease_expires_at=clock_timestamp() where user_id=$1",
      [owner],
    );
    for (let index = 0; index < 7; index++) {
      const requestId = uuid(300 + index);
      assert.equal((await acquire(owner, requestId)).rows[0].retry_after, 0);
      assert.equal((await release(owner, requestId)).rows[0].released, true);
    }
    const rateLimited = await acquire(owner, uuid(400));
    assert.ok(rateLimited.rows[0].retry_after > 0 && rateLimited.rows[0].retry_after <= 60);
    assert.equal((await acquire(uuid(2), uuid(401))).rows[0].retry_after, 0, "the rate limit is per user");

    await db.query(
      "update public.candidate_document_direct_upload_leases set started_at=clock_timestamp()-interval '61 seconds', lease_expires_at=clock_timestamp()-interval '1 second' where user_id=$1",
      [owner],
    );
    assert.equal((await acquire(owner, uuid(500))).rows[0].retry_after, 0, "old completed starts and crashed leases no longer block capacity");

    await db.exec("reset role");
    const permissions = await db.query(`
      select
        has_function_privilege('service_role', 'public.acquire_candidate_document_direct_upload(uuid,uuid)', 'execute') as service_can_acquire,
        has_function_privilege('service_role', 'public.release_candidate_document_direct_upload(uuid,uuid)', 'execute') as service_can_release,
        has_function_privilege('anon', 'public.acquire_candidate_document_direct_upload(uuid,uuid)', 'execute') as anon_can_acquire,
        has_function_privilege('authenticated', 'public.release_candidate_document_direct_upload(uuid,uuid)', 'execute') as authenticated_can_release,
        has_table_privilege('authenticated', 'public.candidate_document_direct_upload_leases', 'select') as authenticated_can_read_rows
    `);
    assert.deepEqual(permissions.rows[0], {
      service_can_acquire: true,
      service_can_release: true,
      anon_can_acquire: false,
      authenticated_can_release: false,
      authenticated_can_read_rows: false,
    });

    await db.exec("set role authenticated");
    await assert.rejects(
      () => acquire(owner, uuid(600)),
      error => error.code === "42501",
    );
  } finally {
    await db.close();
  }
});
