import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL(
  "../supabase/migrations/20261030210000_limit_jobsdb_search_admission.sql",
  import.meta.url,
);

function uuid(value: number) {
  return `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
}

test("JobsDB admission leases enforce per-user/global limits, expiry, and service-only RPCs", async () => {
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
      insert into auth.users(id)
      select ('00000000-0000-0000-0000-' || lpad(value::text, 12, '0'))::uuid
      from generate_series(1, 12) as value;
    `);
    await db.exec(await readFile(migration, "utf8"));
    await db.exec("set role service_role");

    const claim = (userId: string, requestId: string) => db.query(
      "select public.acquire_jobsdb_search_lease($1::uuid, $2::uuid) as admitted",
      [userId, requestId],
    );
    const release = (userId: string, requestId: string) => db.query(
      "select public.release_jobsdb_search_lease($1::uuid, $2::uuid) as released",
      [userId, requestId],
    );

    const ownerA = uuid(1);
    const ownerAClaims = await Promise.all(
      Array.from({ length: 20 }, (_, index) => claim(ownerA, uuid(100 + index))),
    );
    assert.equal(ownerAClaims.filter(result => result.rows[0].admitted).length, 4);
    assert.equal(ownerAClaims.filter(result => !result.rows[0].admitted).length, 16);

    const ownerARequestIds = (await db.query(
      "select request_id from public.jobsdb_search_admission_leases where user_id=$1 order by request_id",
      [ownerA],
    )).rows.map(row => row.request_id as string);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.jobsdb_search_admission_leases where user_id=$1",
      [ownerA],
    )).rows[0].count, 4);
    assert.equal((await release(uuid(2), ownerARequestIds[0]!)).rows[0].released, false);
    assert.equal((await release(ownerA, ownerARequestIds[0]!)).rows[0].released, true);
    assert.equal((await claim(ownerA, uuid(200))).rows[0].admitted, true);

    const leaseDuration = await db.query(
      `select extract(epoch from (lease_expires_at - clock_timestamp())) * 1000 as remaining_ms
       from public.jobsdb_search_admission_leases where request_id=$1`,
      [uuid(200)],
    );
    assert.ok(Number(leaseDuration.rows[0].remaining_ms) > 140_000);
    await db.exec("reset role");
    await db.query(
      "update public.jobsdb_search_admission_leases set lease_expires_at=clock_timestamp()-interval '1 second'",
    );
    await db.exec("set role service_role");
    assert.equal((await claim(ownerA, uuid(201))).rows[0].admitted, true);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.jobsdb_search_admission_leases",
    )).rows[0].count, 1, "an acquire reclaims every expired lease before counting capacity");

    const otherOwnerClaims = await Promise.all(
      Array.from({ length: 7 * 4 }, (_, index) => claim(uuid(2 + Math.floor(index / 4)), uuid(300 + index))),
    );
    assert.equal(otherOwnerClaims.filter(result => result.rows[0].admitted).length, 28);
    const lastOwnerClaims = await Promise.all(
      Array.from({ length: 3 }, (_, index) => claim(uuid(9), uuid(400 + index))),
    );
    assert.equal(lastOwnerClaims.filter(result => result.rows[0].admitted).length, 3);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.jobsdb_search_admission_leases where lease_expires_at > clock_timestamp()",
    )).rows[0].count, 32);
    assert.equal((await claim(uuid(10), uuid(500))).rows[0].admitted, false, "the 33rd live deployment lease is rejected");
    assert.equal((await release(uuid(9), uuid(400))).rows[0].released, true);
    assert.equal((await claim(uuid(10), uuid(501))).rows[0].admitted, true);

    await db.exec("reset role");
    const permissions = await db.query(`
      select
        has_function_privilege('service_role', 'public.acquire_jobsdb_search_lease(uuid,uuid)', 'execute') as service_can_acquire,
        has_function_privilege('service_role', 'public.release_jobsdb_search_lease(uuid,uuid)', 'execute') as service_can_release,
        has_function_privilege('anon', 'public.acquire_jobsdb_search_lease(uuid,uuid)', 'execute') as anon_can_acquire,
        has_function_privilege('authenticated', 'public.release_jobsdb_search_lease(uuid,uuid)', 'execute') as authenticated_can_release
    `);
    assert.deepEqual(permissions.rows[0], {
      service_can_acquire: true,
      service_can_release: true,
      anon_can_acquire: false,
      authenticated_can_release: false,
    });

    await db.exec("set role authenticated");
    await assert.rejects(
      () => claim(uuid(1), uuid(600)),
      error => error.code === "42501",
    );
  } finally {
    await db.close();
  }
});
