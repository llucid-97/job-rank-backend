import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migration = new URL(
  "../supabase/migrations/20261030153000_serialize_stripe_subscription_sync.sql",
  import.meta.url,
);

test("Stripe subscription sync lock migration enforces leases and service-only RPCs", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
    `);
    await db.exec(await readFile(migration, "utf8"));

    const claims = await Promise.all([
      db.query(
        "select public.claim_stripe_subscription_sync($1::text, $2::uuid) as result",
        ["sub-test", "00000000-0000-0000-0000-000000000001"],
      ),
      db.query(
        "select public.claim_stripe_subscription_sync($1::text, $2::uuid) as result",
        ["sub-test", "00000000-0000-0000-0000-000000000002"],
      ),
    ]);
    assert.deepEqual(
      claims.map((claim) => claim.rows[0].result).sort(),
      ["busy", "claimed"],
    );

    const currentToken = (
      await db.query(
        "select processing_claim_token from public.stripe_subscription_sync_locks where stripe_subscription_id = 'sub-test'",
      )
    ).rows[0].processing_claim_token;
    const mismatchedToken =
      currentToken === "00000000-0000-0000-0000-000000000001"
        ? "00000000-0000-0000-0000-000000000002"
        : "00000000-0000-0000-0000-000000000001";
    assert.equal(
      (
        await db.query(
          "select public.release_stripe_subscription_sync($1::text, $2::uuid) as released",
          ["sub-test", mismatchedToken],
        )
      ).rows[0].released,
      false,
    );
    assert.equal(
      (
        await db.query(
          "select public.claim_stripe_subscription_sync($1::text, $2::uuid) as result",
          ["sub-test", "00000000-0000-0000-0000-000000000003"],
        )
      ).rows[0].result,
      "busy",
    );

    assert.equal(
      (
        await db.query(
          "select public.release_stripe_subscription_sync($1::text, $2::uuid) as released",
          ["sub-test", currentToken],
        )
      ).rows[0].released,
      true,
    );
    assert.equal(
      (
        await db.query(
          "select public.claim_stripe_subscription_sync($1::text, $2::uuid) as result",
          ["sub-test", "00000000-0000-0000-0000-000000000004"],
        )
      ).rows[0].result,
      "claimed",
    );

    await db.query(
      `update public.stripe_subscription_sync_locks
       set processing_started_at = pg_catalog.clock_timestamp() - interval '11 minutes'
       where stripe_subscription_id = 'sub-test'`,
    );
    assert.equal(
      (
        await db.query(
          "select public.claim_stripe_subscription_sync($1::text, $2::uuid) as result",
          ["sub-test", "00000000-0000-0000-0000-000000000005"],
        )
      ).rows[0].result,
      "claimed",
    );

    const permissions = await db.query(`
      select
        has_function_privilege('service_role', 'public.claim_stripe_subscription_sync(text,uuid)', 'execute') as service_can_claim,
        has_function_privilege('service_role', 'public.release_stripe_subscription_sync(text,uuid)', 'execute') as service_can_release,
        has_function_privilege('anon', 'public.claim_stripe_subscription_sync(text,uuid)', 'execute') as anon_can_claim,
        has_function_privilege('authenticated', 'public.release_stripe_subscription_sync(text,uuid)', 'execute') as authenticated_can_release
    `);
    assert.deepEqual(permissions.rows[0], {
      service_can_claim: true,
      service_can_release: true,
      anon_can_claim: false,
      authenticated_can_release: false,
    });
  } finally {
    await db.close();
  }
});
