// Audience: maintainers and agents. Synthetic PGlite coverage for the owner-only analysis RPC.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const fixture = new URL("../tests/fixtures/cloud-job-workspace.sql", import.meta.url);
const latestWorkspace = new URL("../supabase/migrations/20261030105248_isolate_workspace_provider_content.sql", import.meta.url);
const analysisMigration = new URL("../supabase/migrations/20261116205821_save_job_analyses.sql", import.meta.url);
const ownerA = "00000000-0000-0000-0000-000000000001";
const ownerB = "00000000-0000-0000-0000-000000000002";

test("analysis patch updates existing owner rows atomically and preserves annotations and shared postings", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role;");
    let sql = await readFile(fixture, "utf8");
    for (const match of [...sql.matchAll(/^\\ir\s+(.+)$/gm)]) {
      const imported = await readFile(new URL(match[1]!.trim(), fixture), "utf8");
      sql = sql.replace(match[0], () => imported.replace(/^\s*(begin|commit);\s*$/gim, ""));
    }
    await db.exec(sql);
    await db.exec(await readFile(latestWorkspace, "utf8"));
    await db.exec(await readFile(analysisMigration, "utf8"));
    await db.exec(`
      grant usage on schema public to service_role;
      grant select, insert, update, delete on public.jobs, public.user_jobs to service_role;
      set role service_role;
    `);
    const job = (id: string, source = "jobsdb") => ({ id, source, title: "Before", companyName: "Shared", location: "Remote", description: "Original description", url: "https://example.invalid", prescriptiveScore: null, summaryJson: null, generatedCoverLetter: "Retain letter", generatedFuqAnswers: "Retain answers", applicationStatus: "Applied", databaseStatus: "applied", applicationNotes: "Keep notes", interviewsNeeded: "Keep letters", isHidden: true, otherData: { keep_me: "owner metadata" } });
    await db.query("select public.save_job_workspace($1,'configured',$2::jsonb,true)", [ownerA, JSON.stringify([job("one"), job("two"), job("three"), job("four"), job("five"), job("six"), ...Array.from({length: 406}, (_, i) => job("untouched-" + i))])]);
    await db.query("select public.save_job_workspace($1,'configured',$2::jsonb,true)", [ownerB, JSON.stringify([job("one")])]);
    await db.query("update public.user_jobs set workspace_data = workspace_data || $1::jsonb where user_id=$2 and workspace_data->>'id'='one'", [JSON.stringify({ prescriptiveScore: 0.8, summaryJson: { old: true }, otherData: { keep_me: "old", processing_error: "stale", search_constraints: { text: "keep context" }, jev_search_matches: ["keep context"], rating_old: 1, candidate_profile_old: "old", ranking_classifier_old: "old" } }), ownerA]);
    const patch = Array.from({ length: 6 }, (_, index) => ({
      id: ["one", "two", "three", "four", "five", "six"][index]!, source: "jobsdb",
      prescriptiveScore: index === 0 ? null : 0.7, summaryJson: index === 0 ? null : { new: index },
      llmVerifiedLocation: "Remote", locationMismatch: false,
      otherData: { candidate_profile_new: "new", jev_new: true, search_constraints: { text: "new context" }, jev_search_matches: ["new context"] },
    }));
    const saved = await db.query("select public.save_job_analyses($1,'configured',$2::jsonb) as data", [ownerA, JSON.stringify(patch)]);
    assert.equal(saved.rows[0]!.data.length, 6);
    const rows = await db.query("select uj.user_id, j.external_id, j.description, uj.application_status::text as status, uj.application_notes, uj.interviews_needed, uj.is_hidden, uj.workspace_data from public.user_jobs uj join public.jobs j on j.id=uj.job_id order by j.external_id, uj.user_id");
    const patched = rows.rows.filter(row => row.user_id === ownerA && ["one", "two", "three", "four", "five", "six"].includes(row.external_id));
    assert.equal(patched.length, 6);
    assert.equal(patched.find(row => row.external_id === "one")!.workspace_data.prescriptiveScore, null);
    assert.equal(patched.find(row => row.external_id === "one")!.workspace_data.summaryJson, null);
    assert.equal(patched.find(row => row.external_id === "one")!.workspace_data.otherData.processing_error, undefined);
    assert.equal(patched.find(row => row.external_id === "one")!.workspace_data.otherData.keep_me, "old");
    assert.deepEqual(patched.find(row => row.external_id === "one")!.workspace_data.otherData.search_constraints, { text: "new context" });
    assert.deepEqual(patched.find(row => row.external_id === "one")!.workspace_data.otherData.jev_search_matches, ["new context"]);
    assert.equal(patched.find(row => row.external_id === "one")!.workspace_data.otherData.candidate_profile_old, undefined);
    assert.equal(patched.find(row => row.external_id === "one")!.workspace_data.generatedCoverLetter, "Retain letter");
    assert.equal(patched.find(row => row.external_id === "one")!.workspace_data.generatedFuqAnswers, "Retain answers");
    assert.equal(patched.find(row => row.external_id === "one")!.application_notes, "Keep notes");
    assert.equal(patched.find(row => row.external_id === "one")!.interviews_needed, "Keep letters");
    assert.equal(patched.find(row => row.external_id === "one")!.status, "applied");
    assert.equal(patched.find(row => row.external_id === "one")!.is_hidden, true);
    assert.equal(rows.rows.find(row => row.user_id === ownerB && row.external_id === "one")!.workspace_data.prescriptiveScore, null);
    assert.equal(rows.rows.find(row => row.external_id === "one")!.description, "Original description");
    assert.equal(rows.rows.filter(row => row.user_id === ownerA).length, 412, "all 406 omitted owner rows remain untouched");

    const before = await db.query("select jsonb_agg(workspace_data order by job_id) as data from public.user_jobs where user_id=$1", [ownerA]);
    for (const invalid of [
      [...patch.slice(0, 5), { ...patch[5]!, id: "deleted" }],
      [...patch.slice(0, 5), { ...patch[5]!, source: "greenhouse" }],
    ]) {
      await assert.rejects(db.query("select public.save_job_analyses($1,'configured',$2::jsonb)", [ownerA, JSON.stringify(invalid)]), /WORKSPACE_ANALYSIS_CONFLICT/);
      const after = await db.query("select jsonb_agg(workspace_data order by job_id) as data from public.user_jobs where user_id=$1", [ownerA]);
      assert.deepEqual(after.rows[0]!.data, before.rows[0]!.data, "one missing owner row rolls back the entire mixed batch");
    }
    assert.equal((await db.query("select public.save_job_analyses($1,'configured','[]'::jsonb) as data", [ownerA])).rows[0]!.data.length, 0);
    const privileges = await db.query(`select has_function_privilege('service_role','public.save_job_analyses(uuid,text,jsonb)','execute') as service,
      has_function_privilege('authenticated','public.save_job_analyses(uuid,text,jsonb)','execute') as authenticated,
      has_function_privilege('anon','public.save_job_analyses(uuid,text,jsonb)','execute') as anon`);
    assert.deepEqual(privileges.rows[0], { service: true, authenticated: false, anon: false });
  } finally {
    await db.close();
  }
});
