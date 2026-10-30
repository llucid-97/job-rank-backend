import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const quotaMigration = new URL("../supabase/migrations/20261030091526_provider_quota.sql", import.meta.url);
const jobsDbQuotaMigration = new URL("../supabase/migrations/20261030105201_jobsdb_provider_quota.sql", import.meta.url);
const entitlementMigration = new URL("../supabase/migrations/20261031000000_enforce_entitlement_provider_request_limit.sql", import.meta.url);

function uuid(value: number) {
  return `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
}

test("paid-provider requests apply active entitlement across kinds and retain per-kind caps", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      create table public.user_entitlements (
        user_id uuid primary key references auth.users(id),
        plan text not null,
        account_status text not null,
        monthly_request_limit integer,
        ai_cost_limit_usd numeric,
        period_started_at timestamptz,
        period_ends_at timestamptz
      );
      alter table public.user_entitlements enable row level security;
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant select on auth.users to service_role;
      grant select, update on public.user_entitlements to service_role;
      insert into auth.users(id)
      select ('00000000-0000-0000-0000-' || lpad(value::text, 12, '0'))::uuid
      from generate_series(1, 8) as value;
      insert into public.user_entitlements (user_id, plan, account_status, monthly_request_limit, ai_cost_limit_usd)
      values
        ('${uuid(1)}', 'free', 'active', 20, 1),
        ('${uuid(2)}', 'starter', 'active', 5, 10),
        ('${uuid(3)}', 'pro', 'active', 200, 100),
        ('${uuid(4)}', 'free', 'active', 20, 1),
        ('${uuid(5)}', 'free', 'suspended', 20, 1),
        ('${uuid(6)}', 'free', 'active', 20, 1),
        ('${uuid(7)}', 'free', 'active', 20, 1);
    `);
    await db.exec(await readFile(quotaMigration, "utf8"));
    await db.exec(await readFile(jobsDbQuotaMigration, "utf8"));
    await db.exec(await readFile(entitlementMigration, "utf8"));
    const functionDefinition = await db.query(
      "select pg_get_functiondef('public.consume_provider_quota(uuid,text,integer,integer)'::regprocedure) as definition",
    );
    const definition = functionDefinition.rows[0].definition as string;
    assert.ok(
      definition.indexOf("pg_advisory_xact_lock") < definition.indexOf("clock_timestamp")
        && definition.indexOf("clock_timestamp") < definition.indexOf("date_trunc"),
      "the UTC month is sampled after acquiring the per-user quota lock",
    );
    assert.match(definition, /provider-quota:/, "the per-user advisory key is namespaced");
    await db.exec("set role service_role");

    const consume = (userId: string, kind = "llm", limit = 100, units = 1) => db.query(
      "select public.consume_provider_quota($1::uuid, $2::text, $3::integer, $4::integer) as allowed",
      [userId, kind, units, limit],
    );

    const freeClaims = await Promise.all(Array.from({ length: 21 }, () => consume(uuid(1))));
    assert.equal(freeClaims.filter(result => result.rows[0].allowed).length, 20);
    assert.equal(freeClaims.filter(result => !result.rows[0].allowed).length, 1, "the 21st free-plan LLM request is denied");
    assert.equal((await db.query(
      "select units from public.provider_quota_usage where user_id=$1 and kind='llm'",
      [uuid(1)],
    )).rows[0].units, 20, "denied requests do not increment the monthly counter");

    const crossKindUser = uuid(7);
    assert.equal((await consume(crossKindUser, "jev", 2000, 5)).rows[0].allowed, true);
    assert.equal((await consume(crossKindUser, "jobsdb", 500, 1)).rows[0].allowed, true);
    const remainingFreeClaims = await Promise.all(Array.from({ length: 18 }, () => consume(crossKindUser)));
    assert.ok(remainingFreeClaims.every(result => result.rows[0].allowed));
    assert.equal((await consume(crossKindUser)).rows[0].allowed, false,
      "the free entitlement aggregates JEV, JobsDB, and LLM operations");
    assert.deepEqual((await db.query(
      "select kind, units from public.provider_quota_usage where user_id=$1 order by kind",
      [crossKindUser],
    )).rows, [
      { kind: "jev", units: 5 },
      { kind: "jobsdb", units: 1 },
      { kind: "llm", units: 18 },
    ], "per-kind units remain distinct from the aggregate operation count");
    assert.equal((await db.query(
      "select requests from public.provider_request_usage where user_id=$1",
      [crossKindUser],
    )).rows[0].requests, 20);

    assert.equal((await consume(uuid(7), "llm", 0)).rows[0].allowed, false,
      "a per-kind hard-cap denial does not consume the aggregate request allowance");
    assert.equal((await db.query(
      "select requests from public.provider_request_usage where user_id=$1",
      [uuid(7)],
    )).rows[0].requests, 20);

    const starterClaims = await Promise.all(Array.from({ length: 8 }, () => consume(uuid(2))));
    assert.equal(starterClaims.filter(result => result.rows[0].allowed).length, 5);
    assert.equal(starterClaims.filter(result => !result.rows[0].allowed).length, 3);

    const paidClaims = await Promise.all(Array.from({ length: 105 }, () => consume(uuid(3))));
    assert.equal(paidClaims.filter(result => result.rows[0].allowed).length, 100,
      "the existing backend llm=100 hard cap still bounds paid plans with higher entitlements");
    assert.equal(paidClaims.filter(result => !result.rows[0].allowed).length, 5);

    // JEV/JobsDB retain their per-kind unit caps, while each admitted call
    // consumes one request from the shared account entitlement.
    assert.equal((await consume(uuid(6), "jev", 2000, 1)).rows[0].allowed, true);
    assert.equal((await consume(uuid(6), "jobsdb", 500, 1)).rows[0].allowed, true);

    const concurrentUser = uuid(4);
    const month = (await db.query(
      "select pg_catalog.date_trunc('month', pg_catalog.now() at time zone 'UTC')::date as month_utc",
    )).rows[0].month_utc;
    await db.query(
      "insert into public.provider_request_usage(user_id, month_utc, requests) values ($1, $2, 19)",
      [concurrentUser, month],
    );
    const concurrentClaims = await Promise.all(Array.from({ length: 25 }, () => consume(concurrentUser)));
    assert.equal(concurrentClaims.filter(result => result.rows[0].allowed).length, 1);
    assert.equal(concurrentClaims.filter(result => !result.rows[0].allowed).length, 24);
    assert.equal((await db.query(
      "select requests from public.provider_request_usage where user_id=$1",
      [concurrentUser],
    )).rows[0].requests, 20);
    assert.equal((await db.query(
      "select units from public.provider_quota_usage where user_id=$1 and kind='llm'",
      [concurrentUser],
    )).rows[0].units, 1, "denied concurrent operations do not increment per-kind units");

    await assert.rejects(
      () => consume(uuid(5)),
      error => error.code === "P0001",
      "suspended entitlements fail closed for a delayed LLM operation",
    );
    await assert.rejects(
      () => consume(uuid(8)),
      error => error.code === "P0001",
      "missing entitlements fail closed for LLM usage",
    );

    await db.exec("reset role");
    const grants = await db.query(`
      select
        has_function_privilege('service_role', 'public.consume_provider_quota(uuid,text,integer,integer)', 'execute') as service_can_consume,
        has_function_privilege('anon', 'public.consume_provider_quota(uuid,text,integer,integer)', 'execute') as anon_can_consume,
        has_function_privilege('authenticated', 'public.consume_provider_quota(uuid,text,integer,integer)', 'execute') as authenticated_can_consume,
        has_table_privilege('anon', 'public.provider_request_usage', 'select') as anon_can_read_usage,
        has_table_privilege('authenticated', 'public.provider_request_usage', 'select') as authenticated_can_read_usage
    `);
    assert.deepEqual(grants.rows[0], {
      service_can_consume: true,
      anon_can_consume: false,
      authenticated_can_consume: false,
      anon_can_read_usage: false,
      authenticated_can_read_usage: false,
    });
  } finally {
    await db.close();
  }
});
