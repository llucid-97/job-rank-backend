import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL(
  "../supabase/migrations/20261030230000_limit_public_feed_requests.sql",
  import.meta.url,
);

function uuid(value: number) {
  return `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
}

test("public feed quota is atomic per UTC minute/day, isolated by user, and service-role-only", async () => {
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
    const functionDefinition = await db.query(
      "select pg_get_functiondef('public.consume_public_feed_request(uuid)'::regprocedure) as definition",
    );
    const definition = functionDefinition.rows[0].definition as string;
    assert.ok(
      definition.indexOf("pg_advisory_xact_lock") < definition.indexOf("clock_timestamp")
        && definition.indexOf("clock_timestamp") < definition.indexOf("date_trunc"),
      "the UTC bucket is sampled after acquiring the per-user lock",
    );
    assert.match(definition, /public-feed-quota:/, "the advisory lock key is namespaced");
    await db.exec("set role service_role");

    const consume = (userId: string) => db.query(
      "select public.consume_public_feed_request($1::uuid) as retry_after",
      [userId],
    );
    const userA = uuid(1);
    const userB = uuid(2);

    const minuteBurst = await Promise.all(
      Array.from({ length: 300 }, () => consume(userA)),
    );
    assert.equal(minuteBurst.filter(result => result.rows[0].retry_after === 0).length, 240);
    const minuteDenials = minuteBurst.filter(result => Number(result.rows[0].retry_after) > 0);
    assert.equal(minuteDenials.length, 60);
    assert.ok(minuteDenials.every(result => Number(result.rows[0].retry_after) <= 60));
    assert.deepEqual((await db.query(
      "select window_kind, requests from public.public_feed_request_usage where user_id=$1 order by window_kind",
      [userA],
    )).rows, [
      { window_kind: "day", requests: 240 },
      { window_kind: "minute", requests: 240 },
    ], "denied minute requests do not increment either bucket");

    // Move the minute bucket into the past and put the daily row one request
    // below its cap to exercise concurrent day-boundary admission.
    await db.exec("reset role");
    await db.exec(`
      update public.public_feed_request_usage
      set window_start = case when window_kind = 'minute'
        then window_start - interval '1 minute' else window_start end,
          requests = case when window_kind = 'day' then 1199 else requests end
      where user_id = '${userA}';
    `);
    await db.exec("set role service_role");
    const dayBurst = await Promise.all(
      Array.from({ length: 20 }, () => consume(userA)),
    );
    assert.equal(dayBurst.filter(result => result.rows[0].retry_after === 0).length, 1);
    const dayDenials = dayBurst.filter(result => Number(result.rows[0].retry_after) > 0);
    assert.equal(dayDenials.length, 19);
    assert.ok(dayDenials.every(result => Number(result.rows[0].retry_after) > 0 && Number(result.rows[0].retry_after) <= 86_400));
    assert.equal((await db.query(
      "select requests from public.public_feed_request_usage where user_id=$1 and window_kind='day'",
      [userA],
    )).rows[0].requests, 1200, "denied day requests do not increment the daily bucket");

    // Another account has an independent budget. Old buckets are reclaimed
    // on that account's next request, keeping storage to at most two rows/user.
    assert.equal((await consume(userB)).rows[0].retry_after, 0);
    await db.exec("reset role");
    await db.exec(`
      update public.public_feed_request_usage
      set window_start = window_start - interval '2 days'
      where user_id = '${userB}';
    `);
    await db.exec("set role service_role");
    assert.equal((await consume(userB)).rows[0].retry_after, 0);
    assert.equal((await db.query(
      "select count(*)::integer as count from public.public_feed_request_usage where user_id=$1",
      [userB],
    )).rows[0].count, 2);

    await db.exec("reset role");
    const privileges = await db.query(`
      select
        has_function_privilege('service_role', 'public.consume_public_feed_request(uuid)', 'execute') as service_can_consume,
        has_function_privilege('anon', 'public.consume_public_feed_request(uuid)', 'execute') as anon_can_consume,
        has_function_privilege('authenticated', 'public.consume_public_feed_request(uuid)', 'execute') as authenticated_can_consume,
        has_table_privilege('anon', 'public.public_feed_request_usage', 'select') as anon_can_read_usage,
        has_table_privilege('authenticated', 'public.public_feed_request_usage', 'select') as authenticated_can_read_usage
    `);
    assert.deepEqual(privileges.rows[0], {
      service_can_consume: true,
      anon_can_consume: false,
      authenticated_can_consume: false,
      anon_can_read_usage: false,
      authenticated_can_read_usage: false,
    });

    await db.exec("set role authenticated");
    await assert.rejects(
      () => consume(userA),
      error => error.code === "42501",
    );
  } finally {
    await db.close();
  }
});
