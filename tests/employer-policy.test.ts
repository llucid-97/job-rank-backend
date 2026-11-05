import assert from 'node:assert/strict';
import { test } from 'node:test';
import { employerBlocksSchema, employerDecision, loadEmployerBlocks } from '../src/modules/account/employer-blocks.js';
import { supabaseAdmin } from '../src/config/supabase.js';
import { generateLlm, rankCategorical } from '../src/modules/provider-proxy/provider.routes.js';

const policy = employerBlocksSchema.parse({ version: 1, companies: [{canonicalName:'Acme Co',aliases:['ACME, Inc.']}], roleExceptions:[{url:'https://example.invalid/job/one',companies:['ACME, Inc.']}] });
test('exact normalization, aliases, URL exception, and unknown', () => {
  assert.equal(employerDecision(policy,{companyName:'acme inc',url:null}).status,'blocked');
  assert.equal(employerDecision(policy,{companyName:'acme inc',url:'https://example.invalid/job/one'}).status,'allowed');
  assert.equal(employerDecision(policy,{companyName:'acme co',url:'https://example.invalid/job/one'}).status,'blocked');
  assert.equal(employerDecision(policy,{companyName:'acme inc',url:'https://example.invalid/job/two'}).status,'blocked');
  assert.equal(employerDecision(policy,{companyName:'Acme Inc Other',url:null}).status,'allowed');
  assert.equal(employerDecision(policy,{companyName:null,url:null}).status,'unknown');
  assert.equal(employerDecision(policy,{companyName:'Unknown',url:null}).status,'unknown');
  assert.equal(employerBlocksSchema.safeParse({version:1,companies:[{canonicalName:'---',aliases:[]}],roleExceptions:[]}).success,false);
});
test('owner policy blocks job constraints before quota or provider', async () => {
  const originalFrom = supabaseAdmin.from; const originalRpc = supabaseAdmin.rpc; const originalFetch = globalThis.fetch;
  let quota = 0; let calls = 0; let owner = '';
  try {
    supabaseAdmin.from = (() => ({select: () => ({eq: (_key:string, id:string) => {owner=id; return {maybeSingle: async () => ({data:{employer_blocks:policy},error:null})};}})})) as any;
    supabaseAdmin.rpc = (async () => { quota++; return {data:true,error:null}; }) as any;
    globalThis.fetch = (async () => { calls++; throw new Error('unexpected'); }) as any;
    await assert.rejects(generateLlm({auth:{userId:'owner-a'},body:{workflow:'jobConstraints',input:{posting:'Synthetic vacancy'},jobContext:{companyName:'Acme Inc',url:null}}} as any, {} as any), (error:any) => error.code === 'EMPLOYER_BLOCKED');
    assert.equal(owner,'owner-a'); assert.equal(quota,0); assert.equal(calls,0);
    assert.deepEqual(await loadEmployerBlocks('owner-b'),policy); assert.equal(owner,'owner-b');
  } finally { supabaseAdmin.from = originalFrom; supabaseAdmin.rpc = originalRpc; globalThis.fetch = originalFetch; }
});

test('tagged opaque generation and categorical ranking stop before quota', async () => {
  const originalFrom = supabaseAdmin.from; const originalRpc = supabaseAdmin.rpc; const originalFetch = globalThis.fetch;
  let quota = 0; let calls = 0;
  try {
    supabaseAdmin.from = (() => ({select: () => ({eq: (_key:string, id:string) => ({maybeSingle: async () => ({data:{employer_blocks: id === 'owner-a' ? policy : {version:1,companies:[],roleExceptions:[]}},error:null})})})})) as any;
    supabaseAdmin.rpc = (async () => { quota++; return {data:true,error:null}; }) as any;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]})); }) as any;
    const context = {companyName:'Acme Inc',url:null};
    await assert.rejects(generateLlm({auth:{userId:'owner-a'},body:{workflow:'candidateProfile',prompt:'Synthetic',jobContext:context}} as any, {} as any), (error:any) => error.code === 'EMPLOYER_BLOCKED');
    await assert.rejects(rankCategorical({auth:{userId:'owner-a'},body:{state:'Synthetic',questions:{q:{type:'score',instructions:'Score',criteria:['low','high']}},model:'jev-latest',jobContext:context}} as any, {} as any), (error:any) => error.code === 'EMPLOYER_BLOCKED');
    assert.equal(quota,0); assert.equal(calls,0);
    const output:any = {json(value:any) { this.body=value; }};
    await generateLlm({auth:{userId:'owner-b'},body:{workflow:'candidateProfile',prompt:'Synthetic',jobContext:context}} as any, output);
    assert.equal(quota,1); assert.equal(calls,1); assert.equal(output.body.data.text,'ok');
    await generateLlm({auth:{userId:'owner-a'},body:{workflow:'candidateProfile',prompt:'Synthetic'}} as any, output);
    assert.equal(quota,2); assert.equal(calls,2);
  } finally { supabaseAdmin.from = originalFrom; supabaseAdmin.rpc = originalRpc; globalThis.fetch = originalFetch; }
});
