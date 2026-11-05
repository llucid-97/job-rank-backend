// Audience: maintainers. Paid document operations must honor the owner's current employer preference.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supabaseAdmin } from '../src/config/supabase.js';
import { generateCoverLetter } from '../src/modules/cover-letter/cover-letter.service.js';
import { generateFollowUpAnswers } from '../src/modules/follow-up-answers/follow-up.service.js';

test('blocked saved job prevents cover letter and follow-up quota or provider work', async () => {
  const originalFrom=supabaseAdmin.from, originalRpc=supabaseAdmin.rpc, originalFetch=globalThis.fetch;
  let quota=0, provider=0;
  try {
    supabaseAdmin.from = ((table:string) => {
      const data = table === 'user_jobs' ? {job_id:'job',workspace_data:{companyName:'Acme Inc',url:'https://example.invalid/job'}} : table === 'jobs' ? {id:'job',company_name:'Wrong employer',application_url:null} : table === 'user_preferences' ? {employer_blocks:{version:1,companies:[{canonicalName:'Acme',aliases:['Acme Inc'],reason:'Skip'}],roleExceptions:[]}} : null;
      const query:any = {select:()=>query,eq:()=>query,maybeSingle:async()=>({data,error:null}),single:async()=>({data,error:null})}; return query;
    }) as any;
    supabaseAdmin.rpc = (async () => {quota++;return {data:true,error:null};}) as any;
    globalThis.fetch = (async () => {provider++;throw new Error('unexpected provider');}) as any;
    for (const action of [() => generateCoverLetter({userId:'owner',jobId:'job',tone:'professional'}), () => generateFollowUpAnswers({userId:'owner',jobId:'job',questions:'Synthetic?'})]) {
      await assert.rejects(action(),(error:any) => error.code === 'EMPLOYER_BLOCKED' && error.details.reason === 'Skip');
    }
    assert.equal(quota,0); assert.equal(provider,0);
  } finally {supabaseAdmin.from=originalFrom;supabaseAdmin.rpc=originalRpc;globalThis.fetch=originalFetch;}
});
