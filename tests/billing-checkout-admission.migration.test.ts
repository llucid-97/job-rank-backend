import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL("../supabase/migrations/20261031130000_serialize_billing_checkout_creation.sql", import.meta.url);

function uuid(value: number) {
  return `00000000-0000-0000-0000-${String(value).padStart(12, "0")}`;
}

test("checkout admission is per-user, recoverable, immutable, and service-only", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      create table public.billing_plans (id uuid primary key, code text not null, stripe_price_id text not null);
      create table public.subscriptions (
        id uuid primary key, user_id uuid not null, status text not null, stripe_subscription_id text unique
      );
      create table public.billing_checkout_sessions (
        id bigint generated always as identity primary key,
        user_id uuid not null, billing_plan_id uuid not null, stripe_checkout_session_id text not null,
        stripe_customer_id text, stripe_subscription_id text, checkout_url text, expires_at timestamptz, status text not null,
        completed_at timestamptz, created_at timestamptz not null default now()
      );
      create table public.billing_customers (user_id uuid primary key, stripe_customer_id text not null, email text);
      grant usage on schema public, auth to anon, authenticated, service_role;
      grant select on auth.users to service_role;
      grant select, insert on public.billing_plans, public.subscriptions to service_role;
      grant select on public.billing_checkout_sessions to service_role;
      grant insert, select, update on public.billing_checkout_sessions to service_role;
      grant select, insert, update on public.billing_customers to service_role;
      insert into auth.users values ('${uuid(1)}'), ('${uuid(2)}'), ('${uuid(3)}'), ('${uuid(4)}');
      insert into public.billing_plans values ('${uuid(10)}', 'starter', 'price-starter'), ('${uuid(11)}', 'pro', 'price-pro');
    `);
    await db.exec(await readFile(migration, "utf8"));
    await db.exec("set role service_role");

    const claim = (userId: string, planId = uuid(10), planCode = "starter", priceId = "price-starter", attempt = uuid(20), token = uuid(30), email = "saved@example.test") => db.query(
      `select public.claim_billing_checkout_attempt($1,$2,$3,$4,$5,$6,$7,$8,$9) as result`,
      [userId, attempt, token, planId, planCode, priceId, email, "https://app.invalid/success", "https://app.invalid/cancel"],
    );

    const owner = uuid(1);
    const concurrent = await Promise.all([
      claim(owner, uuid(10), "starter", "price-starter", uuid(20), uuid(30)),
      claim(owner, uuid(10), "starter", "price-starter", uuid(21), uuid(31)),
    ]);
    assert.deepEqual(concurrent.map(result => result.rows[0].result.status).sort(), ["busy", "claimed"]);
    const admitted = concurrent.find(result => result.rows[0].result.status === "claimed")!.rows[0].result.attempt;
    const attemptId = admitted.attempt_id;
    assert.equal(admitted.customer_create_attempt_id, attemptId);
    assert.equal(admitted.email_snapshot, "saved@example.test");

    const otherOwner = await claim(uuid(2), uuid(10), "starter", "price-starter", uuid(22), uuid(32));
    assert.equal(otherOwner.rows[0].result.status, "claimed", "a different owner has independent capacity");

    const params = { mode: "subscription", customer: "cus-synthetic", success_url: "https://app.invalid/success" };
    const saved = await db.query(
      "select public.save_billing_checkout_params($1,$2,$3,$4,$5::jsonb) as result",
      [owner, attemptId, admitted.claim_token, "cus-synthetic", JSON.stringify(params)],
    );
    assert.deepEqual(saved.rows[0].result.params, params);
    await db.query("select public.mark_billing_checkout_creation_started($1,$2,$3)", [owner, attemptId, admitted.claim_token]);
    await db.query("select public.release_billing_checkout_attempt($1,$2,$3)", [owner, attemptId, admitted.claim_token]);

    const resumed = await claim(owner, uuid(10), "starter", "price-starter", uuid(23), uuid(33), "changed@example.test");
    assert.equal(resumed.rows[0].result.status, "claimed");
    assert.equal(resumed.rows[0].result.attempt.attempt_id, attemptId, "crash retry retains checkout idempotency key");
    assert.deepEqual(resumed.rows[0].result.attempt.checkout_params, params, "crash retry retains exact Stripe parameters");
    assert.equal(resumed.rows[0].result.attempt.email_snapshot, "saved@example.test", "customer creation retry retains its original email");

    await db.query(
      "update public.billing_checkout_attempts set claim_until=now()-interval '1 second', checkout_safe_retry_after=now()-interval '1 second' where user_id=$1",
      [owner],
    );
    const rotated = await claim(owner, uuid(11), "pro", "price-pro", uuid(24), uuid(34), "new@example.test");
    assert.equal(rotated.rows[0].result.status, "claimed");
    assert.equal(rotated.rows[0].result.attempt.attempt_id, uuid(24), "a possibly payable old session is never replaced before safe expiry");
    assert.equal(rotated.rows[0].result.attempt.customer_create_attempt_id, attemptId, "customer recovery key remains stable across checkout attempts");
    assert.equal(rotated.rows[0].result.attempt.checkout_params, null, "new checkout attempt gets fresh parameters");

    await db.query(
      "insert into public.billing_checkout_sessions(user_id,billing_plan_id,stripe_checkout_session_id,checkout_url,expires_at,status) values ($1,$2,'cs-open','https://checkout.invalid/open',now()+interval '1 hour','open')",
      [owner, uuid(11)],
    );
    const reused = await claim(owner, uuid(11), "pro", "price-pro", uuid(25), uuid(35));
    assert.equal(reused.rows[0].result.status, "existing_session");
    assert.equal(reused.rows[0].result.session.stripe_checkout_session_id, "cs-open");
    const crossPlan = await claim(owner, uuid(10), "starter", "price-starter", uuid(26), uuid(36));
    assert.equal(crossPlan.rows[0].result.status, "other_plan_open");

    await db.query("insert into public.subscriptions(id,user_id,status) values ($1,$2,'active')", [uuid(40), owner]);
    const active = await claim(owner, uuid(11), "pro", "price-pro", uuid(27), uuid(37));
    assert.equal(active.rows[0].result.status, "subscription_exists");

    const pendingOwner = uuid(3);
    await db.query(
      "insert into public.billing_checkout_sessions(user_id,billing_plan_id,stripe_checkout_session_id,stripe_subscription_id,checkout_url,expires_at,status) values ($1,$2,'cs-complete','sub-pending','https://checkout.invalid/complete',now()-interval '1 minute','complete')",
      [pendingOwner, uuid(10)],
    );
    const pending = await claim(pendingOwner, uuid(10), "starter", "price-starter", uuid(41), uuid(42));
    assert.equal(pending.rows[0].result.status, "subscription_sync_pending");

    await db.query(
      "insert into public.subscriptions(id,user_id,status,stripe_subscription_id) values ($1,$2,'canceled','sub-pending')",
      [uuid(43), pendingOwner],
    );
    const canceled = await claim(pendingOwner, uuid(10), "starter", "price-starter", uuid(44), uuid(45));
    assert.equal(canceled.rows[0].result.status, "claimed", "terminal subscription sync releases checkout admission");

    const incompleteOwner = uuid(4);
    await db.query(
      "insert into public.billing_checkout_sessions(user_id,billing_plan_id,stripe_checkout_session_id,stripe_subscription_id,checkout_url,expires_at,status) values ($1,$2,'cs-incomplete','sub-incomplete','https://checkout.invalid/incomplete',now()-interval '1 minute','complete')",
      [incompleteOwner, uuid(10)],
    );
    await db.query(
      "insert into public.subscriptions(id,user_id,status,stripe_subscription_id) values ($1,$2,'incomplete','sub-incomplete')",
      [uuid(46), incompleteOwner],
    );
    const unresolved = await claim(incompleteOwner, uuid(10), "starter", "price-starter", uuid(47), uuid(48));
    assert.equal(unresolved.rows[0].result.status, "checkout_subscription_unresolved");

    await db.exec("reset role");
    const grants = await db.query(`
      select
        has_function_privilege('service_role', 'public.claim_billing_checkout_attempt(uuid,uuid,uuid,uuid,text,text,text,text,text)', 'execute') as service_can_claim,
        has_function_privilege('anon', 'public.claim_billing_checkout_attempt(uuid,uuid,uuid,uuid,text,text,text,text,text)', 'execute') as anon_can_claim,
        has_function_privilege('authenticated', 'public.claim_billing_checkout_attempt(uuid,uuid,uuid,uuid,text,text,text,text,text)', 'execute') as authenticated_can_claim,
        has_function_privilege('service_role', 'public.record_billing_checkout_completion(uuid,uuid,text,text,text,text,timestamptz,timestamptz)', 'execute') as service_can_reconcile,
        has_function_privilege('anon', 'public.record_billing_checkout_completion(uuid,uuid,text,text,text,text,timestamptz,timestamptz)', 'execute') as anon_can_reconcile,
        has_table_privilege('anon', 'public.billing_checkout_attempts', 'select') as anon_can_read,
        has_table_privilege('authenticated', 'public.billing_checkout_attempts', 'select') as authenticated_can_read
    `);
    assert.deepEqual(grants.rows[0], {
      service_can_claim: true,
      anon_can_claim: false,
      authenticated_can_claim: false,
      service_can_reconcile: true,
      anon_can_reconcile: false,
      anon_can_read: false,
      authenticated_can_read: false,
    });
    const sessionKeyIndex = await db.query(`
      select i.indisunique
      from pg_catalog.pg_index i
      where i.indexrelid = 'public.billing_checkout_sessions_stripe_checkout_session_id_uidx'::regclass
    `);
    assert.deepEqual(sessionKeyIndex.rows, [{ indisunique: true }]);

    const recordCompletion = (userId: string, planId: string, sessionId: string, subscriptionId: string | null) => db.query(
      "select public.record_billing_checkout_completion($1,$2,$3,$4,$5,$6,$7,$8) as result",
      [userId, planId, sessionId, "cus-reconcile", subscriptionId, "https://checkout.invalid/reconcile", new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString()],
    );
    await db.query(
      "insert into public.billing_checkout_sessions(user_id,billing_plan_id,stripe_checkout_session_id,checkout_url,expires_at,status) values ($1,$2,'cs-reconcile','https://checkout.invalid/reconcile',now()+interval '1 hour','open')",
      [uuid(2), uuid(10)],
    );
    assert.equal((await recordCompletion(uuid(2), uuid(10), "cs-reconcile", "sub-reconcile")).rows[0].result, "completed");
    const reconciled = await db.query(
      "select user_id,billing_plan_id,status,stripe_subscription_id from public.billing_checkout_sessions where stripe_checkout_session_id='cs-reconcile'",
    );
    assert.deepEqual(reconciled.rows[0], {
      user_id: uuid(2), billing_plan_id: uuid(10), status: "complete", stripe_subscription_id: "sub-reconcile",
    });
    await assert.rejects(() => recordCompletion(uuid(1), uuid(10), "cs-reconcile", "sub-reconcile"), /owner or plan metadata conflicts/);
    await assert.rejects(() => recordCompletion(uuid(2), uuid(11), "cs-reconcile", "sub-reconcile"), /owner or plan metadata conflicts/);
    await db.query("update public.billing_checkout_sessions set status='expired' where stripe_checkout_session_id='cs-reconcile'");
    assert.equal((await recordCompletion(uuid(2), uuid(10), "cs-reconcile", "sub-reconcile")).rows[0].result, "ignored_stale");
    const replayed = await db.query(
      "select status from public.billing_checkout_sessions where stripe_checkout_session_id='cs-reconcile'",
    );
    assert.equal(replayed.rows[0].status, "expired", "a delayed completion replay cannot reopen a terminal session");
    assert.equal((await recordCompletion(uuid(3), uuid(11), "cs-webhook-first", "sub-webhook-first")).rows[0].result, "inserted");
    assert.equal((await recordCompletion(uuid(3), uuid(11), "cs-webhook-first", "sub-webhook-first")).rows[0].result, "already_completed");
  } finally {
    await db.close();
  }
});
