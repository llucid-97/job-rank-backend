// Audience: maintainers. Focused synthetic provider contract checks; no network or candidate data.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { supabaseAdmin } from '../src/config/supabase.js';
import { rankCategorical, generateLlm } from '../src/modules/provider-proxy/provider.routes.js';
import { rankingConfiguration } from '../src/modules/rankings/ranking.configuration.js';
import { resolveRankingModel } from '../src/modules/provider-proxy/ranking-models.js';

const originalRpc = supabaseAdmin.rpc;
const originalFrom = supabaseAdmin.from;
const originalFetch = globalThis.fetch;
afterEach(() => { supabaseAdmin.from = originalFrom; supabaseAdmin.rpc = originalRpc; globalThis.fetch = originalFetch; });
function request(model?: string) { return { auth: { userId: 'synthetic-test-user' }, body: { state: { job: 'synthetic' }, questions: { fit: { type: 'choice', instructions: 'Choose one', criteria: { yes: 'yes', no: 'no' } } }, ...(model ? { model } : {}) } } as any; }
function response() { return { statusCode: 200, headers: {} as Record<string,string>, body: undefined as any, set(key: string, value: string) { this.headers[key.toLowerCase()] = value; return this; }, status(code: number) { this.statusCode = code; return this; }, json(body: any) { this.body = body; return this; }, type() { return this; }, send(body: any) { this.body = body; return this; } } as any; }
function emptyPolicy() { supabaseAdmin.from = (() => ({select: () => ({eq: () => ({maybeSingle: async () => ({data: null,error:null})})})})) as any; }
function permit() { emptyPolicy(); supabaseAdmin.rpc = (async () => ({ data: true, error: null })) as any; }

test('default model is Luna medium, while explicit Jev and legacy configuration remain intact', async () => {
  assert.equal(resolveRankingModel(undefined), 'openai/gpt-6-luna');
  assert.equal(resolveRankingModel('jev-latest'), 'jev-latest');
  assert.equal(resolveRankingModel('typesafe/jev-1.13-20260917'), 'jev-latest');
  const cfg = rankingConfiguration();
  assert.equal(cfg.defaultModel, 'openai/gpt-6-luna');
  assert.equal(cfg.classifier, 'jev');
  permit();
  let payload: any, endpoint = '';
  globalThis.fetch = (async (url, init) => { endpoint = String(url); payload = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ model: 'openai/gpt-6-luna', choices: [{ message: { content: JSON.stringify({ answers: { fit: {type:'choice', choice:'yes', probabilities:{yes:0.8,no:0.2}} } }) } }] })); }) as typeof fetch;
  const res = response(); await rankCategorical(request(), res);
  assert.equal(endpoint, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(payload.model, 'openai/gpt-6-luna'); assert.deepEqual(payload.reasoning, { effort: 'medium' }); assert.equal(payload.max_tokens, 4096);
  assert.equal(res.body.answers.fit.choice, 'yes');
});

test('explicit Jev routes to Typesafe independently of the new default', async () => {
  permit(); let payload: any, endpoint = '';
  globalThis.fetch = (async (url, init) => { endpoint = String(url); payload = JSON.parse(String(init?.body)); return new Response(JSON.stringify({model:'jev-1.13.0', answers:{}})); }) as typeof fetch;
  const res = response(); await rankCategorical(request('jev-latest'), res);
  assert.equal(endpoint,'https://api.typesafe.ai/v1/systemone'); assert.equal(payload.model,'jev-latest');
});

for (const kind of ['rank', 'schema']) for (const [status, header, expected] of [[429,'23','23'],[529,'Wed, 21 Oct 2037 07:28:00 GMT','Wed, 21 Oct 2037 07:28:00 GMT'],[402,'',undefined],[503,'',undefined]] as const) {
  test(`${kind} translates upstream ${status} without retry or leaking provider body`, async () => {
    let attempts = 0, charged = 0;
    emptyPolicy();
    supabaseAdmin.rpc = (async () => { charged++; return { data:true,error:null }; }) as any;
    globalThis.fetch = (async () => { attempts++; return new Response('secret upstream text', {status,headers:header?{'Retry-After':header}:undefined}); }) as typeof fetch;
    const res = response();
    if (kind === 'rank') await rankCategorical(request(),res);
    else await generateLlm({auth:{userId:'synthetic-test-user'},body:{prompt:'synthetic'}} as any,res);
    assert.equal(attempts,1); assert.equal(charged,1); assert.equal(res.statusCode,status===529?429:status===503?502:status);
    assert.equal(res.body.error.code,status===429||status===529?'PROVIDER_RATE_LIMITED':status===402?'PROVIDER_CREDIT_EXHAUSTED':'PROVIDER_FAILED');
    assert.equal(res.headers['retry-after'],expected); assert.ok(!JSON.stringify(res.body).includes('secret upstream text'));
  });
}
