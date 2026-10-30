import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

Object.assign(process.env, {
  NODE_ENV: 'test',
  JOBSDB_API_KEY: 'synthetic-jobs',
  JOBSDB_API_HOST_ATS: 'synthetic.invalid',
  JOBSDB_API_ENDPOINT: '/active-ats',
});

const originalFetch = globalThis.fetch;
const { searchJobsDb } = await import('../src/modules/jobs/jobsdb.service.js');
const input = { query: 'test', sourceSite: 'jobsdb', persistResults: true, isRemote: false, countryCodes: [], hasSalary: false, page: 0, daysSincePosted: 7, limit: 2 } as const;

afterEach(() => { globalThis.fetch = originalFetch; });

test('JobsDB rejects a response larger than 4 MiB and cancels its stream', async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024).fill(32);
  let sent = 0;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ === 0) controller.enqueue(new TextEncoder().encode('{"jobs":[]}'));
      else if (sent < 21) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { cancelled = true; },
  }))) as typeof fetch;

  await assert.rejects(searchJobsDb(input), (error: any) => error.statusCode === 502 && error.code === 'JOB_PROVIDER_RESPONSE_TOO_LARGE');
  assert.equal(cancelled, true, 'oversized upstream body is canceled immediately');
});

test('JobsDB returns at most the requested number of provider records', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ jobs: [
    { id: 'one', title: 'One' }, { id: 'two', title: 'Two' }, { id: 'three', title: 'Three' },
  ] }))) as typeof fetch;

  const jobs = await searchJobsDb(input);
  assert.deepEqual(jobs.map(job => job.id), ['one', 'two']);
});

test('JobsDB preserves exactly the requested number of provider records', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ jobs: [
    { id: 'one', title: 'One' }, { id: 'two', title: 'Two' },
  ] }))) as typeof fetch;

  const jobs = await searchJobsDb(input);
  assert.deepEqual(jobs.map(job => job.id), ['one', 'two']);
});

test('JobsDB accepts a response exactly at the byte limit', async () => {
  const prefix = '{"jobs":[]}';
  const body = prefix + ' '.repeat(4 * 1024 * 1024 - Buffer.byteLength(prefix));
  globalThis.fetch = (async () => new Response(body)) as typeof fetch;

  assert.deepEqual(await searchJobsDb(input), []);
});

test('JobsDB preserves provider errors when the upstream response has no body', async () => {
  globalThis.fetch = (async () => new Response(null, { status: 429 })) as typeof fetch;

  await assert.rejects(searchJobsDb(input), (error: any) => error.statusCode === 502 && error.code === 'JOB_PROVIDER_UNAVAILABLE');
});
