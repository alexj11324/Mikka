import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { enrollmentHandoffHTTP, enrollmentHandoffPage } from './subscription-enrollment-handoff'
import { callbackDestination } from '../scripts/byos-claude-loopback-relay.mjs'

const input = { id: randomUUID(), provider: 'claude' as const, handoffKey: 'a'.repeat(43), callbackUrl: `http://localhost:54545/callback?code=synthetic-code&state=${'s'.repeat(43)}` }
const url = 'https://mikka-test123-mikka-dev.vercel.app/mikka/api/subscriptions/enrollments/handoff'
test('scoped handoff transports only an exact completion without operator, owner or vault credentials', async () => {
  const calls: unknown[] = []
  const route = enrollmentHandoffHTTP({ enabled: () => true, client: () => ({ async handoff(body) { calls.push(body); return { id:body.id,provider:'claude',state:'pending_unbound',taskUseAllowed:false } } }) })
  const post = (body: unknown, extra: Record<string,string> = {}, target=url) => route(new Request(target,{method:'POST',headers:{'content-type':'application/json',...extra},body:JSON.stringify(body)}))
  for(const body of [{...input,ownerId:'foreign'},{...input,principal:'operator:foreign'},{...input,provider:'codex'},{...input,action:'bind'},{...input,handoffKey:''},{...input,accessToken:'forbidden'}]) assert.equal((await post(body)).status,409)
  assert.equal((await post(input,{origin:'https://foreign.example'})).status,403)
  assert.equal((await post(input,{'sec-fetch-site':'cross-site'})).status,403)
  assert.equal((await post(input,{},url+'?callbackUrl=never-accepted')).status,403)
  assert.equal((await post(input,{'content-type':'text/plain'})).status,415)
  assert.equal((await post({...input,callbackUrl:'x'.repeat(13000)})).status,409)
  assert.equal(calls.length,0)
  const response=await post(input,{origin:new URL(url).origin})
  assert.equal(response.status,200);assert.match(response.headers.get('cache-control')!,/no-store/)
  assert.deepEqual(calls,[input]);assert.equal((await response.json()).taskUseAllowed,false)
})
test('disabled and failed handoff never echo callback or capability', async()=>{
  const disabled=enrollmentHandoffHTTP({enabled:()=>false,client:()=>{throw Error('not called')}})
  assert.equal((await disabled(new Request(url,{method:'POST'}))).status,404)
  const route=enrollmentHandoffHTTP({enabled:()=>true,client:()=>({async handoff(){throw Error('synthetic-code '+input.handoffKey)}})})
  const result=await route(new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)}))
  assert.equal(result.status,409);assert.deepEqual(await result.json(),{error:'handoff_refused'})
})
test('transport page keeps callback values out of server URLs and locks script/connect origins', async()=>{
  assert.equal(enrollmentHandoffPage(new Request(url),false).status,404)
  assert.equal(enrollmentHandoffPage(new Request(url+'?code=forbidden'),true).status,404)
  const response=enrollmentHandoffPage(new Request(url),true),html=await response.text()
  assert.match(response.headers.get('content-security-policy')!,/default-src 'none'/)
  assert.match(response.headers.get('content-security-policy')!,/connect-src 'self'/)
  assert.match(response.headers.get('content-security-policy')!,/frame-ancestors 'none'/)
  assert.equal(response.headers.get('referrer-policy'),'no-referrer')
  assert.ok(html.includes('history.replaceState'));assert.ok(html.includes('sessionStorage.removeItem'))
  assert.ok(!html.includes(input.handoffKey));assert.ok(!html.includes('INFISICAL'));assert.ok(!html.includes('OPERATOR_TOKEN'))
  const target=new URL(callbackDestination(url,'/callback?code=synthetic-code&state='+'s'.repeat(43),'localhost:54545','s'.repeat(43)))
  assert.equal(target.search,'');assert.equal(new URLSearchParams(target.hash.slice(1)).get('callbackUrl'),input.callbackUrl)
  for(const raw of ['/other?code=x&state='+'s'.repeat(43),'/callback?code=x&state='+'s'.repeat(43)+'&state=x','/callback?code=x#leak']) assert.throws(()=>callbackDestination(url,raw,'localhost:54545','s'.repeat(43)))
  assert.throws(()=>callbackDestination('https://evil.example/mikka/api/subscriptions/enrollments/handoff','/callback?code=x&state='+'s'.repeat(43),'localhost:54545','s'.repeat(43)))
  assert.throws(()=>callbackDestination(url,'/callback?code=x&state='+'s'.repeat(43),'evil.example','s'.repeat(43)))
  assert.throws(()=>callbackDestination(url,'/callback?code=x&state='+'s'.repeat(43),'localhost:54545','x'.repeat(43)))
})
