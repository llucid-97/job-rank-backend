// Audience: maintainers. Exercise authenticated HTTP routes with isolated synthetic storage.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { supabaseAdmin, supabaseAuth } from '../src/config/supabase.js';
import { accountRouter } from '../src/modules/account/account.routes.js';
import { providerRouter } from '../src/modules/provider-proxy/provider.routes.js';
import { errorHandler } from '../src/middleware/error-handling.js';

test('authenticated owners edit separate policies and blocked jobs use no quota or provider', async () => {
  const originalFrom = supabaseAdmin.from, originalRpc = supabaseAdmin.rpc, originalAuth = supabaseAuth.auth.getUser, originalFetch = globalThis.fetch;
  const rows = new Map<string, any>(); let quota = 0, provider = 0;
  try {
    supabaseAuth.auth.getUser = (async (token:string) => ({ data:{ user: token === 'a' || token === 'b' ? {id:token,app_metadata:{}} : null }, error:null })) as any;
    supabaseAdmin.from = ((table:string) => {
      let owner = ''; let updates:any;
      const query:any = {
        select: () => query, eq: (_key:string, value:string) => {owner=value; return query;},
        maybeSingle: async () => ({data:table === 'user_entitlements' ? {account_status:'active'} : rows.get(owner) ?? null,error:null}),
        upsert: (value:any) => {updates=value; owner=value.user_id; return query;},
        then: (resolve:any) => { rows.set(owner,{...rows.get(owner),...updates}); return Promise.resolve({error:null}).then(resolve); },
      }; return query;
    }) as any;
    supabaseAdmin.rpc = (async () => {quota++; return {data:true,error:null};}) as any;
    globalThis.fetch = (async () => {provider++; throw new Error('Unexpected provider call');}) as any;
    const app = express(); app.use(express.json()); app.use('/v1', accountRouter, providerRouter); app.use(errorHandler);
    const server = app.listen(0, '127.0.0.1'); await once(server,'listening');
    try {
      const port = (server.address() as AddressInfo).port;
      const call = (method:string, path:string, owner:string, body?:unknown) => new Promise<{status:number; body:any}>((resolve,reject) => {
        const payload = body === undefined ? '' : JSON.stringify(body);
        const request = http.request({hostname:'127.0.0.1',port,method,path,headers:{authorization:`Bearer ${owner}`,...(payload ? {'content-type':'application/json','content-length':Buffer.byteLength(payload)} : {})}}, response => {
          let text=''; response.setEncoding('utf8'); response.on('data',chunk => text += chunk); response.on('end',() => resolve({status:response.statusCode!,body:JSON.parse(text)}));
        }); request.on('error',reject); request.end(payload);
      });
      const policy = {version:1,companies:[{canonicalName:'Acme',aliases:['Acme Inc'],reason:'Not interested'}],roleExceptions:[]};
      assert.equal((await call('PUT','/v1/preferences/employer-blocks','a',policy)).status,200);
      assert.deepEqual((await call('GET','/v1/preferences/employer-blocks','a')).body.data,policy);
      assert.deepEqual((await call('GET','/v1/preferences/employer-blocks','b')).body.data,{version:1,companies:[],roleExceptions:[]});
      const context = {companyName:'Acme Inc',url:null};
      for (const [path, body] of [
        ['/v1/jev/rank',{state:'Synthetic',questions:{q:{type:'score',instructions:'Score',criteria:['low','high']}},model:'jev-latest',jobContext:context}],
        ['/v1/llm/generate',{workflow:'jobConstraints',input:{posting:'Synthetic'},jobContext:context}],
        ['/v1/llm/generate',{workflow:'candidateProfile',prompt:'Synthetic',jobContext:context}],
      ] as const) {
        const result = await call('POST',path,'a',body);
        assert.equal(result.status,409); assert.equal(result.body.error.code,'EMPLOYER_BLOCKED');
        assert.deepEqual(result.body.error.details,{canonicalName:'Acme',reason:'Not interested'});
      }
      assert.equal(quota,0); assert.equal(provider,0);
      assert.equal((await call('PUT','/v1/preferences/employer-blocks','b',{version:1,companies:[{canonicalName:'Other',aliases:[]}],roleExceptions:[]})).status,200);
      assert.deepEqual((await call('GET','/v1/preferences/employer-blocks','a')).body.data,policy);
    } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
  } finally {supabaseAdmin.from=originalFrom; supabaseAdmin.rpc=originalRpc; supabaseAuth.auth.getUser=originalAuth; globalThis.fetch=originalFetch;}
});
