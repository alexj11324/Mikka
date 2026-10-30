import { strict as assert } from 'node:assert'
import { mock, test } from 'node:test'
import './fixtures/activity-runtime.mjs'

let mode:'fresh'|'stale'|'already'|'pending'='fresh', calls=0
const pool={async query(sql:string) {
  if (sql.startsWith('UPDATE github_ci_observations')) return {rowCount:mode==='stale'?0:1,rows:[]}
  if (sql.startsWith('SELECT 1 FROM github_ci_observations')) return {rowCount:mode==='already'?1:0,rows:[]}
  throw Error('unexpected fixture query')
}}
mock.module(new URL('../lib/db/index.ts',import.meta.url).href,{namedExports:{pool}})
mock.module(new URL('../lib/github/ci/reconcile.ts',import.meta.url).href,{namedExports:{reconcileCi:async()=>{calls++;return {queued:mode==='fresh'?1:0,escalated:0,closed:0,failed:0}}}})
const {POST}=await import('../app/api/cron/ci-final/route')
const secret='synthetic-ci-final-test-secret'
const body=JSON.stringify({watchId:'00000000-0000-4000-8000-000000000001',head:'a'.repeat(40),fingerprint:'b'.repeat(64)})
const request=(token:string,value=body)=>new Request('http://localhost/api/cron/ci-final',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:value})

test('final callback authenticates, rejects stale results and accepts a lost-response retry',async()=>{
  const prior=process.env.CRON_SECRET; process.env.CRON_SECRET=secret
  try {
    assert.equal((await POST(request('wrong'))).status,401); assert.equal(calls,0)
    assert.equal((await POST(request(secret,'x'.repeat(513)))).status,413)
    mode='stale'; assert.equal((await POST(request(secret))).status,409); assert.equal(calls,0)
    mode='pending'; assert.equal((await POST(request(secret))).status,503)
    mode='fresh'; assert.equal((await POST(request(secret))).status,202)
    mode='already'; assert.equal((await POST(request(secret))).status,202)
  } finally { if (prior===undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET=prior }
})
