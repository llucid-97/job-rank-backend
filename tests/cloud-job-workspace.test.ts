// Audience: maintainers and agents. Offline contracts for the real cloud worker and API boundaries.
// SQL constraints/RLS are covered by workspace-database.sql; this fake checks application behavior only.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Writable } from 'node:stream';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', NODE_ENV: 'test', PORT: '3000',
  FRONTEND_URL: 'http://127.0.0.1', SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_PUBLISHABLE_KEY: 'synthetic-public', SUPABASE_SECRET_KEY: 'synthetic-secret',
  OPENROUTER_API_KEY: 'synthetic-openrouter', JOBSDB_API_KEY: 'synthetic-jobs',
  TYPESAFE_API_KEY: 'synthetic-jev', JOBRANK_CLASSIFIER: 'jev', RANKING_CONCURRENCY: '3',
});
const deny = () => { throw new Error('Unexpected network request in offline contract test'); };
globalThis.fetch = deny;
http.request = deny as any;
https.request = deny as any;
net.Socket.prototype.connect = deny as any;

const { supabaseAdmin } = await import('../src/config/supabase.js');
const { scoreProjection, validateAnalysis, rankWithJev } = await import('../src/modules/rankings/ranking.projection.js');
const { calculateCandidateScore } = await import('../src/modules/rankings/ranking.score.js');
const { createRankingRun } = await import('../src/modules/rankings/ranking.service.js');
const { processRankingRun } = await import('../src/modules/rankings/ranking.worker.js');
const { getRankingRun, getRankingRunResults } = await import('../src/modules/rankings/ranking.controller.js');
const { getWorkspace, saveWorkspace } = await import('../src/modules/jobs/workspace.controller.js');
const { getSearchHistory, saveSearchHistory } = await import('../src/modules/jobs/search.controller.js');
const { searchRecord, saveSearch } = await import('../src/modules/jobs/search.repository.js');
const { saveSearchResults } = await import('../src/modules/jobs/job.repository.js');
const { searchJobs } = await import('../src/modules/jobs/job.controller.js');
const { jobSearchSchema } = await import('../src/modules/jobs/job-search.schema.js');
const { loadCandidateSchema } = await import('../src/modules/candidate/candidate-profile.service.js');
const schema = await loadCandidateSchema();

const profile = {
  skills_interests_schema: {
    skills: { languages: { TypeScript: { level: 'Expert', years: 7, projects: ['API service'] }, Rust: { level: 'Beginner', years: 1 } } },
    areas_of_interest: ['Tools', 'Research', 'Tools'],
    professional_background: { education: 'Computer science', seniority: 'senior' },
    compensation: {},
  },
  behavioral_points_schema: { adaptability: ['Changing requirements'], work_preferences: { environment: ['Remote'] }, personal_traits: {} },
};
const projection = {
  skills_interests_schema: { skills: { languages: { TypeScript: true, Rust: true } }, areas_of_interest: { Tools: true, Research: true }, professional_background: { education: true, seniority: true }, compensation: {} },
  behavioral_points_schema: { adaptability: { 'Changing requirements': true }, work_preferences: { environment: { Remote: true } }, personal_traits: {} },
};
function scoreShape(value: any, score = 0.75): any {
  return value === true ? score : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, scoreShape(child, score)]));
}
function analysis(score = 0.75) {
  return { job_summary: { skills_interests_schema: {}, behavioral_points_schema: {} }, candidate_match: { ...scoreShape(projection, score), matches: [] } };
}
function jsonResponse(value: any, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
function jevResponse(body: any, score = 3) { return { model: 'jev-synthetic-resolved', answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'score', score }])) }; }
function request(body: any = {}, userId = 'owner-a', params: any = {}) { return { body, auth: { userId }, params } as any; }
function response() {
  let bytes = '';
  const output: any = new Writable({
    write(chunk, _encoding, callback) { bytes += chunk.toString(); callback(); },
    final(callback) { output.body = JSON.parse(bytes); callback(); },
  });
  output.statusCode = 200;
  output.status = function (code: number) { this.statusCode = code; return this; };
  output.json = function (body: any) { this.body = body; return this; };
  output.type = function () { return this; };
  return output;
}
const originalFrom = supabaseAdmin.from.bind(supabaseAdmin);
const originalRpc = supabaseAdmin.rpc.bind(supabaseAdmin);
const originalConsoleError = console.error;
afterEach(() => {
  supabaseAdmin.from = originalFrom as any;
  supabaseAdmin.rpc = originalRpc as any;
  globalThis.fetch = deny;
  console.error = originalConsoleError;
  process.env.JOBRANK_CLASSIFIER = 'jev';
});

type Query = { table: string; action: string; values?: any; options?: any; fields?: string; filters: Array<[string, any]>; ordering?: Array<[string, boolean]>; greaterThan?: Array<[string, string]>; afterRunJob?: [string, string]; limit?: number; offset?: number; single?: boolean };
/** Record each real query, apply only the basic table operation, and allow deterministic write delays. */
function database(initial: Record<string, any[]> = {}) {
  const rows = structuredClone(initial);
  const calls: Query[] = [];
  const rpcCalls: Array<{ name: string; args: any }> = [];
  let generated = 0;
  const hooks = { before: undefined as undefined | ((query: Query) => Promise<any>) };
  /** Apply recorded query semantics and await injected delays to reproduce worker races. */
  async function execute(query: Query) {
    calls.push(structuredClone(query));
    const early = await hooks.before?.(query);
    if (early) return early;
    const table = rows[query.table] ??= [];
    const valueAt = (row: any, key: string) => key === 'ranking_runs.user_id'
      ? rows.ranking_runs?.find(run => run.id === row.ranking_run_id)?.user_id
      : key.startsWith('result_snapshot->>') ? row.result_snapshot?.[key.slice('result_snapshot->>'.length)] : row[key];
    const matches = (row: any) => query.filters.every(([key, value]) => Array.isArray(value) ? value.includes(valueAt(row, key)) : valueAt(row, key) === value)
      && (query.greaterThan ?? []).every(([key, value]) => row[key] > value)
      && (!query.afterRunJob || row.ranking_run_id > query.afterRunJob[0]
        || (row.ranking_run_id === query.afterRunJob[0] && row.job_id > query.afterRunJob[1]));
    let selected = table.filter(matches);
    if (query.action === 'update') selected.forEach(row => Object.assign(row, structuredClone(query.values)));
    if (query.action === 'delete') rows[query.table] = table.filter(row => !matches(row));
    // Preserve conflict behavior so retries and imports exercise annotation ownership.
    if (query.action === 'insert' || query.action === 'upsert') {
      const incoming = Array.isArray(query.values) ? query.values : [query.values];
      /** Model conflict identity without allowing an import to overwrite existing notes. */
      selected = incoming.map((value: any) => {
        const keys = query.options?.onConflict?.split(',') ?? ['id'];
        const existing = query.action === 'upsert' ? table.find(row => keys.every((key: string) => (row[key] ?? null) === (value[key] ?? null))) : undefined;
        if (existing) { if (!query.options?.ignoreDuplicates) Object.assign(existing, structuredClone(value)); return existing; }
        const row = { id: `generated-${++generated}`, ...structuredClone(value) }; table.push(row); return row;
      });
    }
    if (query.ordering) {
      selected = [...selected].sort((a, b) => {
        for (const [key, ascending] of query.ordering!) {
          const comparison = String(a[key]).localeCompare(String(b[key])) * (ascending ? 1 : -1);
          if (comparison) return comparison;
        }
        return 0;
      });
    }
    const count = selected.length;
    if (query.offset !== undefined) selected = selected.slice(query.offset);
    if (query.limit !== undefined) selected = selected.slice(0, query.limit);
    if (query.table === 'user_jobs' && query.fields?.includes('jobs(')) {
      selected = selected.map(row => ({ ...row, jobs: rows.jobs?.find(job => job.id === row.job_id) ?? null }));
    }
    // Return copies to model the PostgREST transport: later writes cannot mutate an earlier response.
    return { data: structuredClone(query.single ? selected[0] ?? null : selected), error: null, count };
  }
  /** Expose a chainable SDK boundary while keeping the in-memory rows test-owned. */
  supabaseAdmin.from = ((table: string) => {
    const query: Query = { table, action: 'select', filters: [] };
    const builder: any = {
      select(fields = '*') { query.fields = fields; return builder; },
      eq(key: string, value: any) { query.filters.push([key, value]); return builder; },
      in(key: string, value: any[]) { query.filters.push([key, value]); return builder; },
      order(key: string, options: any = { ascending: true }) { (query.ordering ??= []).push([key, options.ascending]); return builder; },
      gt(key: string, value: string) { (query.greaterThan ??= []).push([key, value]); return builder; },
      or(expression: string) {
        const match = /^ranking_run_id\.gt\.([^,]+),and\(ranking_run_id\.eq\.\1,job_id\.gt\.([^,)]+)\)$/.exec(expression);
        assert.ok(match, `Unexpected composite cursor: ${expression}`);
        query.afterRunJob = [match[1], match[2]];
        return builder;
      },
      range(from: number, to: number) { query.offset = from; query.limit = to - from + 1; return builder; },
      limit(value: number) { query.limit = value; return builder; },
      single() { query.single = true; return builder; }, maybeSingle() { query.single = true; return builder; },
      insert(values: any) { query.action = 'insert'; query.values = values; return builder; },
      update(values: any) { query.action = 'update'; query.values = values; return builder; },
      upsert(values: any, options: any) { query.action = 'upsert'; query.values = values; query.options = options; return builder; },
      delete() { query.action = 'delete'; return builder; },
      then(resolve: any, reject: any) { return execute(query).then(resolve, reject); },
    };
    return builder;
  }) as any;
  supabaseAdmin.rpc = (async (name: string, args: any) => { rpcCalls.push({ name, args: structuredClone(args) }); return { data: name === 'consume_provider_quota' ? true : [], error: null }; }) as any;
  return { rows, calls, rpcCalls, hooks };
}
function rankingDatabase(jobIds = ['job-1']) {
  return database({
    candidate_documents: [{ id: 'cv-a', user_id: 'owner-a', document_type: 'cv', is_active: true, extracted_text: 'Synthetic CV with TypeScript and Rust.' }],
    candidate_profiles: [{ id: 'profile-a', user_id: 'owner-a', cv_document_id: 'cv-a', skills_profile: profile, schema_hash: schema.schemaHash, policy_version: schema.policyVersion, created_at: '2026-10-01' }],
    jobs: jobIds.map(id => ({ id, title: 'Developer', description: id, location: 'London', provider_payload: {} })),
    user_jobs: jobIds.map(job_id => ({ user_id: 'owner-a', job_id })),
    ranking_runs: [], ranking_run_jobs: [], job_rankings: [], generation_usage: [],
  });
}

test('projection collapses skill detail and uses distinct array values as score paths without mutating profile', () => {
  /** Prove projection collapses skill detail and uses distinct array values as score paths without mutating profile. Synthetic transport keeps this contract independent of live accounts. */
  const before = structuredClone(profile);
  assert.deepEqual(scoreProjection(profile), projection);
  assert.deepEqual(profile, before);
  assert.throws(() => scoreProjection({ skills_interests_schema: { areas_of_interest: [null] } }));
});

test('score equals shifted geometric mean, reaches endpoints, ignores empty objects and excludes behavioral leaves', () => {
  /** Prove score equals shifted geometric mean, reaches endpoints, ignores empty objects and excludes behavioral leaves. Synthetic transport keeps this contract independent of live accounts. */
  for (const value of [0, 0.25, 0.75, 1]) assert.ok(Math.abs(calculateCandidateScore(analysis(value)) - value) < 1e-12);
  const mixed = { candidate_match: { skills_interests_schema: { a: 0, b: 1, empty: {} }, behavioral_points_schema: { ignored: 0 } } };
  assert.ok(Math.abs(calculateCandidateScore(mixed) - (Math.sqrt(0.11) - 0.1)) < 1e-12);
  assert.equal(calculateCandidateScore({ candidate_match: { skills_interests_schema: {} } }), 0);
  for (const invalid of [NaN, Infinity, -0.1, 1.1, '0.5', null, []]) {
    assert.throws(() => calculateCandidateScore({ candidate_match: { skills_interests_schema: { invalid } } }));
  }
});

test('analysis rejects missing/extra paths and nonnumeric or out-of-range scores in either root', () => {
  /** Prove analysis rejects missing/extra paths and nonnumeric or out-of-range scores in either root. Synthetic transport keeps this contract independent of live accounts. */
  assert.doesNotThrow(() => validateAnalysis(analysis(), projection));
  const changes = [
    (a: any) => { delete a.candidate_match.skills_interests_schema.skills.languages.Rust; },
    (a: any) => { a.candidate_match.skills_interests_schema.invented = 0.5; },
    (a: any) => { a.candidate_match.skills_interests_schema.areas_of_interest.Tools = '0.5'; },
    (a: any) => { a.candidate_match.behavioral_points_schema.adaptability['Changing requirements'] = 1.01; },
    (a: any) => { a.candidate_match.behavioral_points_schema.work_preferences.environment = []; },
    (a: any) => { delete a.job_summary; },
    (a: any) => { a.candidate_match.matches = {}; },
  ];
  for (const mutate of changes) { const a = analysis(); mutate(a); assert.throws(() => validateAnalysis(a, projection)); }
});

test('analysis rejects malformed summary and match explanations before Flutter receives them', () => {
  /** Prove analysis rejects malformed summary and match explanations before Flutter receives them. Synthetic transport keeps this contract independent of live accounts. */
  for (const invalidSummary of ['bad summary', 42, [], true]) {
    const a = { ...analysis(), job_summary: invalidSummary };
    assert.throws(() => validateAnalysis(a, projection), `job_summary type ${typeof invalidSummary}`);
  }
  for (const invalidMatch of [null, 'bad match', { skill_or_requirement: [], reason: 'r', evidence: 'e' }]) {
    const a = analysis() as any; a.candidate_match.matches = [invalidMatch];
    assert.throws(() => validateAnalysis(a, projection), `malformed match ${JSON.stringify(invalidMatch)}`);
  }
});

test('Jev asks one question per candidate leaf and normalizes ordinal answers with resolved-model provenance', async () => {
  /** Prove Jev asks one question per candidate leaf and normalizes ordinal answers with resolved-model provenance. Synthetic transport keeps this contract independent of live accounts. */
  let sent: any;
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone'); sent = JSON.parse(init.body);
    return jsonResponse(jevResponse(sent, 2));
  }) as any;
  const result = await rankWithJev({ description: 'Synthetic job', cv: 'Synthetic CV', profile, schema: {}, model: 'jev-latest' });
  assert.equal(Object.keys(sent.questions).length, 8);
  assert.equal(result.model, 'jev-synthetic-resolved');
  assert.deepEqual(result.analysis.candidate_match, { ...scoreShape(projection, 2 / 3), matches: [] });
  assert.match(sent.questions.q0000.instructions, /TypeScript/);
  assert.match(sent.questions.q0000.instructions, /Expert/);
  assert.match(sent.questions.q0006.instructions, /Changing requirements/);
  validateAnalysis(result.analysis, projection);
});

test('Jev rejects absent/wrong question IDs, missing provenance, invalid score values, and provider errors', async () => {
  /** Prove Jev rejects absent/wrong question IDs, missing provenance, invalid score values, and provider errors. Synthetic transport keeps this contract independent of live accounts. */
  const mutations = [
    (r: any) => { delete r.answers.q0000; },
    (r: any) => { r.answers.foreign = r.answers.q0000; delete r.answers.q0000; },
    (r: any) => { delete r.model; },
    (r: any) => { r.answers.q0000.type = 'text'; },
    (r: any) => { r.answers.q0000.score = -1; },
    (r: any) => { r.answers.q0000.score = 4; },
    (r: any) => { r.answers.q0000.score = '2'; },
    (r: any) => { r.answers.q0000.score = null; },
  ];
  for (const mutate of mutations) {
    globalThis.fetch = (async (_: any, init: any) => { const r = jevResponse(JSON.parse(init.body)); mutate(r); return jsonResponse(r); }) as any;
    await assert.rejects(rankWithJev({ description: 'job', cv: 'cv', profile, schema: {}, model: 'jev-latest' }));
  }
  globalThis.fetch = (async () => jsonResponse({ error: 'synthetic failure' }, 503)) as any;
  await assert.rejects(rankWithJev({ description: 'job', cv: 'cv', profile, schema: {}, model: 'jev-latest' }), /503/);
});

test('empty profile produces a valid zero score without a provider call', async () => {
  /** Prove empty profile produces a valid zero score without a provider call. Synthetic transport keeps this contract independent of live accounts. */
  globalThis.fetch = deny;
  const result = await rankWithJev({ description: 'job', cv: 'cv', profile: { skills_interests_schema: {}, behavioral_points_schema: {} }, schema: {}, model: 'jev-latest' });
  validateAnalysis(result.analysis, { skills_interests_schema: {}, behavioral_points_schema: {} });
  assert.equal(calculateCandidateScore(result.analysis), 0);
});

test('run creation binds the current profile and exact owned membership; foreign jobs and stale profiles stop creation', async () => {
  /** Prove run creation binds the current profile and exact owned membership; foreign jobs and stale profiles stop creation. Synthetic transport keeps this contract independent of live accounts. */
  const db = rankingDatabase(['job-1', 'job-2']);
  const created = await createRankingRun('owner-a', ['job-2', 'job-1']);
  assert.equal(created.run.candidate_profile_id, 'profile-a');
  assert.equal(created.run.total_jobs, 2);
  assert.deepEqual(db.rows.ranking_run_jobs.map(row => row.job_id).sort(), ['job-1', 'job-2']);
  await assert.rejects(createRankingRun('owner-a', ['foreign-job']), (error: any) => error.code === 'INVALID_JOB_SELECTION');
  assert.equal(db.rows.ranking_runs.length, 1);
  db.rows.candidate_profiles[0].schema_hash = 'obsolete-schema';
  await assert.rejects(createRankingRun('owner-a', ['job-1']), (error: any) => error.code === 'STALE_SKILLS_PROFILE');
  assert.equal(db.rows.ranking_runs.length, 1);
});

test('run creation rolls back its header when membership persistence fails', async () => {
  /** Prove run creation rolls back its header when membership persistence fails. Synthetic transport keeps this contract independent of live accounts. */
  const db = rankingDatabase();
  db.hooks.before = async query => query.table === 'ranking_run_jobs' && query.action === 'insert' ? { data: null, error: new Error('synthetic membership failure') } : undefined;
  await assert.rejects(createRankingRun('owner-a', ['job-1']), /membership failure/);
  assert.deepEqual(db.rows.ranking_runs, []);
  assert.deepEqual(db.calls.find(query => query.action === 'delete')?.filters, [['id', 'generated-1'], ['user_id', 'owner-a']]);
});

test('concurrent run publishes monotonic counters and separate snapshots for mixed success/failure', async () => {
  /** Prove concurrent run publishes monotonic counters and separate snapshots for mixed success/failure. Synthetic transport keeps this contract independent of live accounts. */
  const db = rankingDatabase(['slow-success', 'quick-failure', 'quick-success']);
  const created = await createRankingRun('owner-a', ['slow-success', 'quick-failure', 'quick-success']);
  const writes: Array<{ processed_jobs: number; succeeded_jobs: number; failed_jobs: number }> = [];
  let activeWrites = 0, maxWrites = 0, activeProvider = 0, maxProvider = 0;
  db.hooks.before = async query => {
    if (query.table !== 'ranking_runs' || query.values?.processed_jobs === undefined) return;
    activeWrites++; maxWrites = Math.max(maxWrites, activeWrites);
    await new Promise(resolve => setTimeout(resolve, query.values.processed_jobs === 1 ? 20 : 1));
    writes.push(structuredClone(query.values)); activeWrites--;
  };
  globalThis.fetch = (async (_: any, init: any) => {
    const body = JSON.parse(init.body); activeProvider++; maxProvider = Math.max(maxProvider, activeProvider);
    await new Promise(resolve => setTimeout(resolve, body.state.job_description === 'slow-success' ? 30 : 1));
    activeProvider--;
    const value = jevResponse(body, 3); if (body.state.job_description === 'quick-failure') value.answers.q0000.score = 99;
    return jsonResponse(value);
  }) as any;
  console.error = () => {};
  await processRankingRun(created.run.id, 'owner-a', created.jobIds);
  const run = db.rows.ranking_runs[0];
  assert.equal(run.status, 'partially_completed');
  assert.deepEqual([run.total_jobs, run.processed_jobs, run.succeeded_jobs, run.failed_jobs], [3, 3, 2, 1]);
  assert.ok(maxProvider > 1, 'Test exercised concurrent provider work');
  assert.equal(maxWrites, 1, 'Progress updates must not overlap and arrive out of order');
  assert.ok(writes.every((row, i) => row.processed_jobs === row.succeeded_jobs + row.failed_jobs && row.processed_jobs >= (writes[i - 1]?.processed_jobs ?? 0)));
  assert.deepEqual(db.rows.ranking_run_jobs.map(row => row.status).sort(), ['failed', 'rated', 'rated']);
  assert.equal(db.rows.job_rankings.length, 2);
  assert.ok(db.rows.ranking_run_jobs.filter(row => row.status === 'rated').every(row => row.result_snapshot.resolved_model === 'jev-synthetic-resolved' && row.result_snapshot.prescriptive_score === 1));
  assert.equal(db.rows.generation_usage.length, 0, 'Jev calls must not be recorded as OpenRouter usage');
});

test('failed retry retains the last valid rating and the earlier run snapshot', async () => {
  /** Prove failed retry retains the last valid rating and the earlier run snapshot. Synthetic transport keeps this contract independent of live accounts. */
  const db = rankingDatabase();
  globalThis.fetch = (async (_: any, init: any) => jsonResponse(jevResponse(JSON.parse(init.body), 2))) as any;
  const first = await createRankingRun('owner-a', ['job-1']);
  await processRankingRun(first.run.id, 'owner-a', first.jobIds);
  const savedRating = structuredClone(db.rows.job_rankings[0]);
  const savedSnapshot = structuredClone(db.rows.ranking_run_jobs[0].result_snapshot);
  globalThis.fetch = (async () => jsonResponse({ error: 'synthetic failure' }, 503)) as any;
  console.error = () => {};
  const second = await createRankingRun('owner-a', ['job-1']);
  await processRankingRun(second.run.id, 'owner-a', second.jobIds);
  assert.deepEqual(db.rows.job_rankings, [savedRating]);
  assert.deepEqual(db.rows.ranking_run_jobs[0].result_snapshot, savedSnapshot);
  assert.equal(db.rows.ranking_run_jobs[1].result_snapshot.status, 'failed');
  assert.deepEqual(db.rows.ranking_runs.map(run => [run.status, run.processed_jobs, run.succeeded_jobs, run.failed_jobs]), [['completed', 1, 1, 0], ['failed', 1, 0, 1]]);
});

test('CV replacement during provider work rejects the result before a valid rating can be stored', async () => {
  /** Prove CV replacement during provider work rejects the result before a valid rating can be stored. Synthetic transport keeps this contract independent of live accounts. */
  const db = rankingDatabase();
  globalThis.fetch = (async (_: any, init: any) => {
    db.rows.candidate_documents[0].is_active = false;
    return jsonResponse(jevResponse(JSON.parse(init.body)));
  }) as any;
  console.error = () => {};
  const created = await createRankingRun('owner-a', ['job-1']);
  await processRankingRun(created.run.id, 'owner-a', created.jobIds);
  assert.equal(db.rows.ranking_runs[0].status, 'failed');
  assert.equal(db.rows.ranking_runs[0].failed_jobs, 1);
  assert.deepEqual(db.rows.job_rankings, []);
  assert.match(db.rows.ranking_run_jobs[0].error_message, /CV or profile schema changed/);
});

test('removing the saved job during provider work rejects its result', async () => {
  /** Prove removing the saved job during provider work rejects its result. Synthetic transport keeps this contract independent of live accounts. */
  const db = rankingDatabase();
  globalThis.fetch = (async (_: any, init: any) => {
    db.rows.user_jobs.length = 0;
    return jsonResponse(jevResponse(JSON.parse(init.body)));
  }) as any;
  console.error = () => {};
  const created = await createRankingRun('owner-a', ['job-1']);
  await processRankingRun(created.run.id, 'owner-a', created.jobIds);
  assert.deepEqual(db.rows.job_rankings, []);
  assert.equal(db.rows.ranking_runs[0].failed_jobs, 1);
  assert.match(db.rows.ranking_run_jobs[0].error_message, /saved job changed/);
});

test('changing the job description during provider work rejects the obsolete result', async () => {
  /** Prove changing the job description during provider work rejects the obsolete result. Synthetic transport keeps this contract independent of live accounts. */
  const db = rankingDatabase();
  globalThis.fetch = (async (_: any, init: any) => {
    db.rows.jobs[0].description = 'A new description';
    return jsonResponse(jevResponse(JSON.parse(init.body)));
  }) as any;
  console.error = () => {};
  const created = await createRankingRun('owner-a', ['job-1']);
  await processRankingRun(created.run.id, 'owner-a', created.jobIds);
  assert.deepEqual(db.rows.job_rankings, []);
  assert.equal(db.rows.ranking_runs[0].failed_jobs, 1);
  assert.match(db.rows.ranking_run_jobs[0].error_message, /saved job changed/);
});

test('LLM route accepts valid fenced JSON, validates score shape, and records usage only on success', async () => {
  /** Prove LLM route accepts valid fenced JSON, validates score shape, and records usage only on success. Synthetic transport keeps this contract independent of live accounts. */
  const db = rankingDatabase(['job-good', 'job-bad']);
  process.env.JOBRANK_CLASSIFIER = 'llm';
  globalThis.fetch = (async (url: any, init: any) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body);
    const generated = analysis(0.75) as any;
    if (body.messages[0].content.includes('Job Description:\njob-bad')) delete generated.candidate_match.skills_interests_schema.skills.languages.Rust;
    return jsonResponse({ id: 'synthetic-request', choices: [{ message: { content: '```json\n' + JSON.stringify(generated) + '\n```' } }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 } });
  }) as any;
  console.error = () => {};
  const created = await createRankingRun('owner-a', ['job-good', 'job-bad']);
  await processRankingRun(created.run.id, 'owner-a', created.jobIds);
  assert.equal(db.rows.ranking_runs[0].status, 'partially_completed');
  assert.equal(db.rows.job_rankings.length, 1);
  assert.equal(db.rows.generation_usage.length, 1);
  assert.equal(db.rows.generation_usage[0].provider_request_id, 'synthetic-request');
  assert.equal(db.rows.generation_usage[0].input_tokens, 100);
});

test('run result reads require owner header and return immutable per-run snapshots, excluding unfinished jobs', async () => {
  /** Prove run result reads require owner header and return immutable per-run snapshots, excluding unfinished jobs. Synthetic transport keeps this contract independent of live accounts. */
  const snapshot = { job_id: 'job-1', status: 'rated', prescriptive_score: 0.8 };
  const db = database({ ranking_runs: [{ id: 'run-a', user_id: 'owner-a' }, { id: 'run-b', user_id: 'owner-b' }], ranking_run_jobs: [{ ranking_run_id: 'run-a', result_snapshot: snapshot }, { ranking_run_id: 'run-a', result_snapshot: null }, { ranking_run_id: 'run-b', result_snapshot: { private: 'other owner' } }], job_rankings: [{ ranking_run_id: 'run-a', prescriptive_score: 0.1 }] });
  const own = response(); await getRankingRunResults(request({}, 'owner-a', { runId: 'run-a' }), own);
  assert.deepEqual(own.body.data, [snapshot]);
  const count = db.calls.length;
  const foreign = response(); await getRankingRunResults(request({}, 'owner-a', { runId: 'run-b' }), foreign);
  assert.equal(foreign.statusCode, 404);
  assert.equal(db.calls.length - count, 1, 'Reject foreign owner before fetching membership');
  const header = response(); await getRankingRun(request({}, 'owner-a', { runId: 'run-b' }), header);
  assert.equal(header.statusCode, 404);
  assert.ok(!db.calls.some(query => query.table === 'job_rankings'), 'Run reads must not depend on latest-rating cache');
});

test('workspace and saved-search boundaries always use the authenticated owner and enforce source match', async () => {
  /** Prove workspace and saved-search boundaries always use the authenticated owner and enforce source match. Synthetic transport keeps this contract independent of live accounts. */
  const db = database({ user_jobs: [{ user_id: 'owner-a', job_id: 'a' }, { user_id: 'owner-b', job_id: 'b' }], saved_searches: [{ user_id: 'owner-a', query: 'mine', last_used_at: '2026-10-02' }, { user_id: 'owner-b', query: 'private', last_used_at: '2026-10-03' }] });
  const workspace = response(); await getWorkspace(request(), workspace); assert.deepEqual(workspace.body.data.map((row: any) => row.job_id), ['a']);
  const history = response(); await getSearchHistory(request(), history); assert.deepEqual(history.body.data.map((row: any) => row.query), ['mine']);
  const job = { id: 'external-1', source: 'jobsdb', title: 'Title', companyName: 'Co', location: '', description: '', url: '', applicationStatus: 'Offer Received', user_id: 'owner-b', databaseStatus: 'rejected' };
  await saveWorkspace(request({ user_id: 'owner-b', sourceSite: 'jobsdb', replace: false, jobs: [job] }), response());
  assert.equal(db.rpcCalls[0].args.p_user_id, 'owner-a');
  assert.equal(db.rpcCalls[0].args.p_replace, false);
  assert.equal(db.rpcCalls[0].args.p_refresh_provider_content, false);
  assert.equal(db.rpcCalls[0].args.p_jobs[0].databaseStatus, 'offer_received', 'Server derives enum from validated public status');
  const mismatch = response(); await saveWorkspace(request({ sourceSite: 'linkedin', jobs: [job] }), mismatch);
  assert.equal(mismatch.statusCode, 400);
  assert.equal(db.rpcCalls.length, 1);
  await saveSearchHistory(request({ user_id: 'owner-b', searches: [{ query: '  Rust  ', locationMode: 'remote', countryScope: 'GB', hasSalary: false, city: null, user_id: 'owner-b' }] }), response());
  assert.equal(db.rpcCalls[1].args.p_user_id, 'owner-a');
  assert.equal(db.rpcCalls[1].args.p_searches[0].query, 'Rust');
  assert.ok(!('user_id' in db.rpcCalls[1].args.p_searches[0]));
});

test('search identity normalizes countries and blank city; repeat provider jobs preserve user annotations', async () => {
  /** Prove search identity normalizes countries and blank city; repeat provider jobs preserve user annotations. Synthetic transport keeps this contract independent of live accounts. */
  const input = jobSearchSchema.parse({ query: 'provider query', historyQuery: '  Original query  ', countryCodes: ['us', 'GB', 'US'], city: '   ', hasSalary: true });
  const record = searchRecord('owner-a', input);
  assert.deepEqual({ ...record, last_used_at: undefined }, { user_id: 'owner-a', query: 'Original query', location_mode: 'all', country_scope: 'GB,US', has_salary: true, city: null, last_used_at: undefined });
  const db = database({ jobs: [{ id: 'canonical', source: 'jobsdb', external_id: 'external-1' }], user_jobs: [{ user_id: 'owner-a', job_id: 'canonical', application_status: 'interviewing', application_notes: 'Keep notes', is_hidden: true }] });
  const jobs = await saveSearchResults('owner-a', [{ id: 'external-1', title: 'Old title' }, { id: 'external-1', title: 'New title' }]);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].title, 'New title');
  assert.deepEqual(db.rows.user_jobs, [{ user_id: 'owner-a', job_id: 'canonical', application_status: 'interviewing', application_notes: 'Keep notes', is_hidden: true }]);
  await saveSearch('owner-a', input);
  assert.equal(db.rows.saved_searches[0].query, 'Original query');
});

test('successful zero-result provider search still saves history for the authenticated owner', async () => {
  /** Prove successful zero-result provider search still saves history for the authenticated owner. Synthetic transport keeps this contract independent of live accounts. */
  const db = database();
  process.env.JOBSDB_API_HOST_ATS = 'synthetic.invalid';
  process.env.JOBSDB_API_ENDPOINT = '/active-ats';
  globalThis.fetch = (async () => jsonResponse({ jobs: [] })) as any;
  const res = response();
  await searchJobs(request({ query: 'no matching jobs', userId: 'owner-b' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.data, []);
  assert.equal(db.rows.saved_searches[0].user_id, 'owner-a');
  assert.equal(db.rows.saved_searches[0].query, 'no matching jobs');
  assert.ok(!db.calls.some(query => query.table === 'jobs'));
});


test('workspace reload reads the server result without a browser score write and preserves owner annotations', async () => {
  /** Prove workspace reload reads the server result without a browser score write and preserves owner annotations. Synthetic transport keeps this contract independent of live accounts. */
  // The immutable run result restores the score; workspace JSON remains annotation-owned.
  const db = rankingDatabase();
  db.rows.user_jobs[0].workspace_data = { id: 'external-1', applicationNotes: 'Keep my note' };
  const run = await createRankingRun('owner-a', ['job-1']);
  globalThis.fetch = (async (_: any, init: any) => jsonResponse(jevResponse(JSON.parse(init.body)))) as any;
  await processRankingRun(run.run.id, 'owner-a', run.jobIds);
  const output = response();
  await getWorkspace(request(), output);
  const restored = output.body.data[0];
  assert.equal(restored.workspace_data.applicationNotes, 'Keep my note');
  assert.equal(restored.workspace_data.prescriptiveScore, undefined);
  assert.equal(restored.ranking_results.length, 1);
  assert.equal(restored.ranking_results[0].candidate_profile_id, 'profile-a');
  assert.equal(restored.ranking_results[0].status, 'rated');
  assert.match(restored.ranking_results[0].job_input_identity, /^[a-f0-9]{64}$/);
  const other = response();
  await getWorkspace(request({}, 'owner-b'), other);
  assert.deepEqual(other.body.data, []);
});

test('workspace keyset paging keeps every surviving row when an earlier row is deleted under a REST cap', async () => {
  /** Exercise the real SDK with exact remaining counts, a smaller REST cap, and a concurrent deletion. */
  const allRows = Array.from({ length: 1001 }, (_, i) => ({
    job_id: `job-${String(i).padStart(4, '0')}`, workspace_data: { id: `external-${i}` }, jobs: { source: 'jobicy' },
  }));
  const surviving = [...allRows];
  const requests: string[] = [];
  /** Model PostgREST's cap and remaining-row counts, deleting a prior-page row on request two. */
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'synthetic.invalid');
    if (url.pathname === '/rest/v1/ranking_run_jobs') {
      assert.equal(url.searchParams.get('ranking_runs.user_id'), 'eq.owner-a');
      assert.match(url.searchParams.get('select')!, /ranking_runs!inner\(user_id\)/);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'content-range': '*/0' } });
    }
    assert.equal(url.pathname, '/rest/v1/user_jobs');
    assert.equal(url.searchParams.get('user_id'), 'eq.owner-a');
    assert.equal(url.searchParams.get('order'), 'job_id.asc');
    assert.equal(url.searchParams.has('offset'), false);
    if (requests.length === 1) surviving.shift();
    requests.push(url.search);
    const after = url.searchParams.get('job_id')?.replace(/^gt\./, '');
    const remaining = surviving.filter(row => !after || row.job_id > after);
    const page = remaining.slice(0, Math.min(100, Number(url.searchParams.get('limit'))));
    return new Response(JSON.stringify(page), { status: 200, headers: {
      'content-type': 'application/json', 'content-range': `0-${page.length - 1}/${remaining.length}`,
    }});
  }) as any;
  const output = response();
  await getWorkspace(request(), output);
  const returned = new Set(output.body.data.map((row: any) => row.job_id));
  assert.equal(returned.size, allRows.length);
  assert.ok(surviving.every(row => returned.has(row.job_id)), 'Deletion before the cursor must not skip a surviving association');
  assert.equal(requests.length, 11);
});

test('progress-write failure waits for already running job work before publishing a terminal run', async () => {
  /** Prove progress-write failure waits for already running job work before publishing a terminal run. Synthetic transport keeps this contract independent of live accounts. */
  const db = rankingDatabase(['fast', 'slow']);
  const created = await createRankingRun('owner-a', ['fast', 'slow']);
  let injected = false, slowDone = false;
  db.hooks.before = async query => {
    if (!injected && query.table === 'ranking_runs' && query.values?.processed_jobs === 1) {
      injected = true;
      return { data: null, error: new Error('synthetic one-off progress-write failure') };
    }
  };
  globalThis.fetch = (async (_: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.state.job_description === 'slow') {
      await new Promise(resolve => setTimeout(resolve, 60));
      slowDone = true;
    }
    return jsonResponse(jevResponse(body));
  }) as any;
  console.error = () => {};
  await processRankingRun(created.run.id, 'owner-a', created.jobIds);
  const atReturn = { slowDone, status: db.rows.ranking_runs[0].status,
    pending: db.rows.ranking_run_jobs.filter(row => row.status === 'processing').length };
  // Let outstanding real worker promises finish before restoring shared test doubles.
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(injected, true);
  assert.equal(atReturn.slowDone, true,
    `processRankingRun returned terminal status ${atReturn.status} with ${atReturn.pending} job(s) still running`);
  assert.equal(atReturn.pending, 0);
});


test('snapshot publication failure preserves the previous valid cache and workspace result', async () => {
  /** Force one confirmed database rejection after provider success and preserve the older result. */
  const db = rankingDatabase();
  globalThis.fetch = (async (_: any, init: any) => jsonResponse(jevResponse(JSON.parse(init.body)))) as any;
  const first = await createRankingRun('owner-a', ['job-1']);
  await processRankingRun(first.run.id, 'owner-a', first.jobIds);
  const earlier = structuredClone(db.rows.job_rankings[0]);
  const second = await createRankingRun('owner-a', ['job-1']);
  let failedOnce = false;
  db.hooks.before = async query => {
    if (!failedOnce && query.table === 'ranking_run_jobs' && query.values?.status === 'rated'
      && query.filters.some(([key, value]) => key === 'ranking_run_id' && value === second.run.id)) {
      failedOnce = true;
      return { data: null, error: new Error('Synthetic confirmed snapshot rejection') };
    }
  };
  console.error = () => {};
  await processRankingRun(second.run.id, 'owner-a', second.jobIds);
  assert.equal(failedOnce, true);
  assert.equal(db.rows.ranking_runs[1].status, 'failed');
  assert.deepEqual(db.rows.job_rankings[0], earlier);
  const output = response();
  await getWorkspace(request(), output);
  assert.equal(output.body.data[0].ranking_results.length, 1);
  assert.equal(output.body.data[0].ranking_results[0].rated_at, db.rows.ranking_run_jobs[0].result_snapshot.rated_at);
});

test('planner probes refresh shared provider content and history without saving account results', async () => {
  /** An abandoned probe may refresh public content and query history, but must not save an account job. */
  const db = database({ jobs: [{ id: 'canonical', source: 'jobsdb', external_id: 'external-1', title: 'Old title' }] });
  globalThis.fetch = (async () => jsonResponse({ jobs: [{ id: 'external-1', title: 'New title' }] })) as any;
  await searchJobs(request({ query: 'probe', persistResults: false }), response());
  assert.equal(db.rows.jobs[0].title, 'New title');
  assert.equal(db.rows.saved_searches[0].query, 'probe');
  assert.equal(db.rows.user_jobs?.length ?? 0, 0);
  assert.ok(!db.calls.some(query => query.table === 'user_jobs'));
  // Omitting the new flag preserves the existing API contract for ordinary callers.
  await searchJobs(request({ query: 'accepted' }), response());
  assert.equal(db.rows.user_jobs.length, 1);
  assert.equal(db.rows.user_jobs[0].user_id, 'owner-a');
});

test('workspace validates known client fields and requires explicit import-only provider refresh', async () => {
  /** Reject values the client cannot deserialize, and keep shared refresh separate from replacement. */
  const db = database();
  const job = { id: 'external-1', source: 'jobicy', title: 'Title', companyName: 'Co', location: '', description: '', url: '', applicationStatus: 'Applied' };
  for (const extras of [{ skills: [42] }, { prescriptiveScore: '0.5' }, { apiJobData: [] }, { summaryJson: 'bad' }, { generatedFuqAnswers: {} }, { locationMismatch: 'false' }, { interviewsNeeded: 2 }]) {
    await assert.rejects(() => saveWorkspace(request({ sourceSite: 'configured', jobs: [{ ...job, ...extras }] }), response()));
  }
  await assert.rejects(() => saveWorkspace(request({ sourceSite: 'configured', refreshProviderContent: true, jobs: [job] }), response()), /requires an import/);
  assert.equal(db.rpcCalls.length, 0);
  await saveWorkspace(request({ sourceSite: 'configured', replace: false, refreshProviderContent: true, jobs: [{ ...job, skills: ['TypeScript'], prescriptiveScore: 0.5, apiJobData: null, summaryJson: {}, generatedFuqAnswers: null, locationMismatch: false, interviewsNeeded: 'Two', futureOptionalField: 'kept' }] }), response());
  assert.equal(db.rpcCalls[0].args.p_refresh_provider_content, true);
  assert.equal(db.rpcCalls[0].args.p_replace, false);
  assert.equal(db.rpcCalls[0].args.p_jobs[0].futureOptionalField, 'kept');
});

test('confirmed rated snapshots survive cache rejection, lost cache response, and usage transport failure', async () => {
  /** Once the authoritative snapshot succeeds, auxiliary failures must not hide or demote it. */
  for (const failure of ['cache-rejected', 'cache-committed-response-lost', 'usage-response-lost']) {
    const db = rankingDatabase();
    process.env.JOBRANK_CLASSIFIER = failure.startsWith('usage') ? 'llm' : 'jev';
    globalThis.fetch = (async (_: any, init: any) => {
      const body = JSON.parse(init.body);
      return jsonResponse(body.questions ? jevResponse(body) : { choices: [{ message: { content: JSON.stringify(analysis()) } }], usage: {} });
    }) as any;
    const run = await createRankingRun('owner-a', ['job-1']);
    let injected = false;
    db.hooks.before = async query => {
      if (!injected && query.table === (failure.startsWith('usage') ? 'generation_usage' : 'job_rankings') && query.action !== 'select') {
        injected = true;
        if (failure === 'cache-committed-response-lost') db.rows.job_rankings.push(structuredClone(query.values));
        if (failure.endsWith('response-lost')) throw new Error('Synthetic transport response lost');
        return { data: null, error: new Error('Synthetic confirmed cache rejection') };
      }
    };
    console.error = () => {};
    await processRankingRun(run.run.id, 'owner-a', run.jobIds);
    assert.equal(injected, true, failure);
    assert.equal(db.rows.ranking_runs[0].status, 'completed', failure);
    assert.equal(db.rows.ranking_runs[0].succeeded_jobs, 1, failure);
    assert.equal(db.rows.ranking_run_jobs[0].status, 'rated', failure);
    const output = response();
    await getWorkspace(request(), output);
    assert.deepEqual(output.body.data[0].ranking_results, [db.rows.ranking_run_jobs[0].result_snapshot], failure);
    assert.ok(!db.calls.some(query => query.table === 'job_rankings' && query.action === 'select'));
  }
});

test('workspace pages owner-rated snapshots by composite key and orders newest results first', async () => {
  /** Page historical results while excluding foreign owners, old versions, and failed runs. */
  const db = rankingDatabase(['job-1', 'job-2']);
  const { rankingVersion } = await import('../src/modules/rankings/ranking.configuration.js');
  for (let i = 0; i < 201; i++) {
    const id = `run-${String(i).padStart(3, '0')}`;
    db.rows.ranking_runs.push({ id, user_id: 'owner-a' });
    for (const job_id of ['job-1', 'job-2']) db.rows.ranking_run_jobs.push({ ranking_run_id: id, job_id, status: 'rated', completed_at: id, result_snapshot: { ranking_version: rankingVersion, marker: id } });
  }
  db.rows.ranking_runs.push({ id: 'foreign', user_id: 'owner-b' }, { id: 'failed', user_id: 'owner-a' }, { id: 'obsolete', user_id: 'owner-a' });
  for (const [id, status, version] of [['foreign', 'rated', rankingVersion], ['failed', 'failed', rankingVersion], ['obsolete', 'rated', 'old-version']]) {
    db.rows.ranking_run_jobs.push({ ranking_run_id: id, job_id: 'job-1', status, result_snapshot: { ranking_version: version, marker: id } });
  }
  const output = response();
  await getWorkspace(request(), output);
  for (const row of output.body.data) {
    assert.equal(row.ranking_results.length, 201);
    assert.equal(row.ranking_results[0].marker, 'run-200');
    assert.equal(row.ranking_results.at(-1).marker, 'run-000');
  }
  assert.equal(db.calls.filter(query => query.table === 'ranking_run_jobs').length, 3);
});
