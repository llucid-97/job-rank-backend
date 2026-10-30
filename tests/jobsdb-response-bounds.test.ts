import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

Object.assign(process.env, {
  NODE_ENV: 'test',
  JOBSDB_API_KEY: 'synthetic-jobs',
  JOBSDB_API_HOST_ATS: 'synthetic.invalid',
  JOBSDB_API_ENDPOINT: '/active-ats',
});

const originalFetch = globalThis.fetch;
const { extractProviderJobs, searchJobsDb } = await import('../src/modules/jobs/jobsdb.service.js');
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

test('JobsDB streams supported array shapes with the existing precedence and object filtering', () => {
  const fromRoot = extractProviderJobs(Buffer.from('[null,{"id":"one"},[],{"id":"two"},{"id":"extra"}]'), 2);
  assert.deepEqual(fromRoot, [{ id: 'one' }, { id: 'two' }]);

  const fromEnvelope = extractProviderJobs(Buffer.from('{"data":{},"jobs":[null,{"id":"one"},{"id":"two"}],"results":[{"id":"ignored"}]}'), 2);
  assert.deepEqual(fromEnvelope, [{ id: 'one' }, { id: 'two' }]);

  for (const key of ['data', 'jobs', 'results', 'items']) {
    assert.deepEqual(
      extractProviderJobs(Buffer.from(JSON.stringify({ [key]: [{ id: key }] })), 2),
      [{ id: key }],
    );
  }

  const precedence = extractProviderJobs(Buffer.from('{"data":[],"jobs":[{"id":"ignored"}]}'), 2);
  assert.deepEqual(precedence, []);
});

test('JobsDB streaming parser preserves last duplicate key semantics and rejects malformed trailing JSON', async () => {
  assert.deepEqual(
    extractProviderJobs(Buffer.from('{"jobs":[{"id":"old"}],"jobs":[{"id":"new"}]}'), 2),
    [{ id: 'new' }],
  );
  assert.deepEqual(
    extractProviderJobs(Buffer.from('{"jobs":[{"id":"old"}],"jobs":null,"results":[{"id":"fallback"}]}'), 2),
    [{ id: 'fallback' }],
  );

  const overDepth = '['.repeat(129) + ']'.repeat(129);
  for (const invalidBody of [
    '{"jobs":[{"id":"one"}]} trailing',
    '',
    '  ',
    '\uFEFF{"jobs":[]}',
    overDepth,
  ]) {
    globalThis.fetch = (async () => new Response(invalidBody)) as typeof fetch;
    await assert.rejects(searchJobsDb(input), /JobsDB returned an invalid JSON response/);
  }
});

test('JobsDB streaming parser accepts 128 nesting levels and rejects level 129', () => {
  const atLimit = Buffer.from('['.repeat(128) + ']'.repeat(128));
  assert.deepEqual(extractProviderJobs(atLimit, 2), []);

  const overLimit = Buffer.from('['.repeat(129) + ']'.repeat(129));
  assert.throws(extractProviderJobs.bind(null, overLimit, 2), /maximum JSON nesting depth/);
});

test('JobsDB does not materialize every compact provider record before applying the result limit', () => {
  const count = 1_000_000;
  const body = Buffer.from('{"jobs":[' + '{},'.repeat(count - 1) + '{}]}');
  assert.ok(body.byteLength < 4 * 1024 * 1024);
  assert.deepEqual(extractProviderJobs(body, 2), [{}, {}]);
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
