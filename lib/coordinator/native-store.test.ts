import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { before, after, test } from 'node:test'
import { Pool } from 'pg'
import { NativeCoordinatorStore } from './native-store'

const url = process.env.NATIVE_COORDINATOR_TEST_DATABASE_URL
if (url) {
  const parsed = new URL(url)
  if (!['127.0.0.1','localhost'].includes(parsed.hostname) || parsed.pathname !== '/mikka_native_test') throw new Error('Native Coordinator tests require an isolated localhost mikka_native_test database')
}
const schema = `native_${randomUUID().replaceAll('-','')}`
const admin = url ? new Pool({ connectionString: url }) : null
const pool = url ? new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 }) : null
const store = pool ? new NativeCoordinatorStore(pool) : null
const check = (name: string, fn: () => Promise<void>) => test(name,{ skip: !url },fn)

before(async () => {
  if (!admin || !pool) return
  await admin.query(`CREATE SCHEMA ${schema}`)
  await pool.query(`CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,enabled boolean DEFAULT true,"lastSeenAt" timestamptz DEFAULT now(),harnesses jsonb);
    CREATE TABLE coordinator_sessions ("userId" text PRIMARY KEY,"leaseHolder" text,"leaseUntil" timestamptz);`)
  await pool.query(await readFile(new URL('../../drizzle/20261026170000_native_coordinator.sql',import.meta.url),'utf8'))
})
after(async () => { await pool?.end(); await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin?.end() })

async function person() {
  const userId = randomUUID(),deviceId = randomUUID(),holder = randomUUID()
  await pool!.query('INSERT INTO devices (id,"ownerId",harnesses) VALUES ($1,$2,$3)',[deviceId,userId,JSON.stringify([{ harness:'codex',installed:true,coordinator:true }])])
  const runtime = { harness:'codex' as const,deviceId }
  await store!.setRuntime(userId,runtime)
  await pool!.query('UPDATE coordinator_sessions SET "leaseHolder"=$2,"leaseUntil"=now()+interval \'10 minutes\' WHERE "userId"=$1',[userId,holder])
  const input = { instructions:'You are Mikka.',context:'[Memory] Chinese\n[Event] New mail',tools:[{ name:'propose_reply',description:'Propose, do not send',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false} }] }
  const id = await store!.enqueue(userId,holder,0,runtime,input)
  return { userId,deviceId,holder,runtime,input,id }
}

check('default remains AI SDK and runtime changes require an owned capable device', async () => {
  assert.deepEqual(await store!.runtime(randomUUID()),{ harness:'ai_sdk' })
  await assert.rejects(store!.setRuntime(randomUUID(),{ harness:'codex',deviceId:randomUUID() }),/DeviceUnavailable/)
  const p = await person()
  assert.deepEqual(await store!.runtime(p.userId),p.runtime)
  await assert.rejects(store!.setRuntime(p.userId,{ harness:'ai_sdk' }),/Busy/)
})
check('parallel claims start only one native execution; another owner cannot claim it', async () => {
  const p = await person()
  assert.equal(await store!.claim(randomUUID(),p.deviceId),null)
  const claims = await Promise.all(Array.from({length:8},()=>store!.claim(p.userId,p.deviceId)))
  assert.equal(claims.filter(Boolean).length,1)
  assert.equal(claims.find(Boolean)?.context,p.input.context)
})
check('tool roundtrip is fenced, idempotent, validated by the workflow and preserves OpenUI', async () => {
  const p = await person(); await store!.claim(p.userId,p.deviceId)
  const command = { type:'tool' as const,callId:'call-1',name:'propose_reply',input:{text:'draft'} }
  await Promise.all([store!.submit(p.userId,p.deviceId,p.id,command),store!.submit(p.userId,p.deviceId,p.id,command)])
  await assert.rejects(store!.submit(p.userId,p.deviceId,p.id,{...command,input:{text:'changed'}}),/Conflict/)
  await assert.rejects(store!.submit(randomUUID(),p.deviceId,p.id,command),/Unavailable/)
  await assert.rejects(store!.submit(p.userId,randomUUID(),p.id,command),/Unavailable/)
  await assert.rejects(store!.submit(p.userId,p.deviceId,p.id,{...command,name:'shell'}),/Unavailable/)
  const state = await store!.poll(p.userId,p.holder,p.id)
  assert.equal(state.calls.length,1)
  await store!.finishTool(p.userId,p.holder,p.id,command.callId,{pendingApproval:true})
  assert.deepEqual(await store!.result(p.userId,p.deviceId,p.id,command.callId),{status:'done',output:{pendingApproval:true}})
  const text = 'root = TextContent("收到邮件，需要处理吗？")'
  await store!.submit(p.userId,p.deviceId,p.id,{type:'complete',text})
  assert.equal((await store!.poll(p.userId,p.holder,p.id)).reply,text)
  await store!.close(p.userId,p.holder,p.id)
  await assert.rejects(store!.result(p.userId,p.deviceId,p.id,command.callId),/Unavailable/)
})
check('expired/revoked leases and disabled devices cannot dispatch more effects', async () => {
  const p = await person(); await store!.claim(p.userId,p.deviceId)
  await pool!.query('UPDATE coordinator_sessions SET "leaseHolder"=$2 WHERE "userId"=$1',[p.userId,'replacement'])
  await assert.rejects(store!.poll(p.userId,p.holder,p.id),/LeaseLost/)
  await assert.rejects(store!.submit(p.userId,p.deviceId,p.id,{type:'complete',text:'late'}),/Unavailable/)
  const q = await person(); await pool!.query('UPDATE devices SET enabled=false WHERE id=$1',[q.deviceId])
  assert.equal(await store!.claim(q.userId,q.deviceId),null)
})
check('concurrent requests cannot exceed the per-turn budget and existing calls remain retryable', async () => {
  const p = await person(); await store!.claim(p.userId,p.deviceId)
  const command = (index:number) => ({type:'tool' as const,callId:`call-${index}`,name:'propose_reply',input:{text:'draft'}})
  const outcomes = await Promise.allSettled(Array.from({length:45},(_,i)=>store!.submit(p.userId,p.deviceId,p.id,command(i))))
  assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,40)
  await store!.submit(p.userId,p.deviceId,p.id,command(0))
  assert.equal((await store!.poll(p.userId,p.holder,p.id)).calls.length,40)
})
