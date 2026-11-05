import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
let scans=0,fail=false
let nextDue:number|null=null,armed=0
mock.module('../../../../lib/schedules/runtime.ts',{namedExports:{sweepSchedules:async()=>{scans++;if(fail)throw new Error('private internal failure');return{materialized:2,executed:2}},scheduleNextDue:async()=>nextDue}})
mock.module('../../../../lib/due-timer.ts',{namedExports:{armDueTimer:async(kind:string)=>{assert.equal(kind,'schedules');armed++}}})
let GET:typeof import('./route').GET
before(async()=>{({GET}=await import('./route'))})
const previous=process.env.CRON_SECRET
const secret='isolated-schedule-cron-secret-fixture-179'
beforeEach(()=>{scans=0;fail=false;nextDue=null;armed=0;process.env.CRON_SECRET=secret})
after(()=>{if(previous===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=previous})
const request=(token?:string)=>new Request('http://localhost/mikka/api/cron/schedules',{headers:token?{authorization:`Bearer ${token}`}:{}})
test('missing config refuses without scanning',async()=>{delete process.env.CRON_SECRET;assert.equal((await GET(request())).status,503);assert.equal(scans,0)})
test('anonymous and incorrect credentials cannot scan other owners',async()=>{assert.equal((await GET(request())).status,401);assert.equal((await GET(request('wrong'))).status,401);assert.equal(scans,0)})
test('the existing cron bearer can scan and receives only no-store counts',async()=>{const r=await GET(request(secret));assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{materialized:2,executed:2});assert.equal(scans,1)})
test('internal errors produce a bounded safe failure',async()=>{fail=true;const r=await GET(request(secret));assert.equal(r.status,502);assert.deepEqual(await r.json(),{error:'scheduleSweepFailed'});assert.equal(scans,1)})
test('the slow sweep re-arms the due timer when work is due later, recovering a lost start',async()=>{nextDue=Date.now()+60_000;assert.equal((await GET(request(secret))).status,200);assert.equal(armed,1)})
test('with nothing due the sweep starts no timer',async()=>{assert.equal((await GET(request(secret))).status,200);assert.equal(armed,0)})
test('refused callers never arm a timer',async()=>{nextDue=Date.now();assert.equal((await GET(request('wrong'))).status,401);assert.equal(armed,0)})
