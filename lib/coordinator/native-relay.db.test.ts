import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { after, before, mock, test } from 'node:test'
import { Pool } from 'pg'
import { tool } from 'ai'
import { z } from 'zod'
import { FatalError } from 'workflow'
import { NativeCoordinatorStore } from './native-store'

const url = process.env.NATIVE_COORDINATOR_TEST_DATABASE_URL ?? (process.env.REQUIRE_DB === '1' ? process.env.E2E_DATABASE_URL : undefined)
if (url) {
  const parsed = new URL(url)
  const ci = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && process.env.REQUIRE_DB === '1' && url === process.env.E2E_DATABASE_URL
  if (!['127.0.0.1','localhost'].includes(parsed.hostname) || (parsed.pathname !== '/mikka_native_test' && !(ci && parsed.pathname === '/mikka_e2e')) || parsed.search || parsed.hash) throw new Error('Native relay tests require an isolated localhost test database')
} else if (process.env.REQUIRE_DB === '1') throw new Error('Native relay database is required')
const schema = `relay_${randomUUID().replaceAll('-','')}`
const admin = url ? new Pool({ connectionString: url }) : null
const pool = url ? new Pool({ connectionString: url, options: `-c search_path=${schema}` }) : null
const store = pool ? new NativeCoordinatorStore(pool) : null
let turnId = ''

mock.module('../../workflows/coordinator/native-steps.ts', { namedExports: {
  enqueue: async () => turnId,
  poll: (...args: Parameters<NativeCoordinatorStore['poll']>) => store!.poll(...args),
  finishTool: (...args: Parameters<NativeCoordinatorStore['finishTool']>) => store!.finishTool(...args),
  close: (...args: Parameters<NativeCoordinatorStore['close']>) => store!.close(...args),
} })
mock.module('./native.ts', { namedExports: { nativeCoordinatorStore: {
  assertToolActive: (...args: Parameters<NativeCoordinatorStore['assertToolActive']>) => store!.assertToolActive(...args),
} } })
mock.module('workflow', { namedExports: { sleep: async () => undefined, FatalError } })
let nativeCoordinatorTurn: typeof import('../../workflows/coordinator/native-turn').nativeCoordinatorTurn
let assertNativeToolScope: typeof import('../../workflows/coordinator/tool-scope').assertNativeToolScope

before(async () => {
  ;({nativeCoordinatorTurn}=await import('../../workflows/coordinator/native-turn'))
  ;({assertNativeToolScope}=await import('../../workflows/coordinator/tool-scope'))
  if (!admin || !pool) return
  await admin.query(`CREATE SCHEMA ${schema}`)
  await pool.query(`CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text,enabled boolean DEFAULT true,"lastSeenAt" timestamptz DEFAULT now(),harnesses jsonb);
    CREATE TABLE coordinator_sessions ("userId" text PRIMARY KEY,"leaseHolder" text,"leaseUntil" timestamptz);`)
  await pool.query(await readFile(new URL('../../drizzle/20261026170000_native_coordinator.sql',import.meta.url),'utf8'))
})
after(async () => { await pool?.end(); await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin?.end() })

/** The person's Coordinator: an ordinary bot row (this isolated schema has no bots table). */
const COORDINATOR_BOT='c1000000-0000-4000-8000-0000000c0de1'
for (const revoked of ['device','lease','deadline','failed','closed'] as const) {
  test(`relay stops the remaining batch after ${revoked} revocation`, { skip: !url }, async () => {
    const userId=randomUUID(),deviceId=randomUUID(),holder=randomUUID()
    await pool!.query('INSERT INTO devices (id,"ownerId",harnesses) VALUES ($1,$2,$3)',[deviceId,userId,JSON.stringify([{harness:'codex',installed:true,coordinator:true}])])
    const runtime={harness:'codex' as const,deviceId}
    await store!.setRuntime(userId,runtime)
    await pool!.query('UPDATE coordinator_sessions SET "leaseHolder"=$2,"leaseUntil"=now()+interval \'10 minutes\' WHERE "userId"=$1',[userId,holder])
    turnId=await store!.enqueue(userId,holder,0,runtime,{instructions:'Mikka',context:'Authorized context',tools:[{name:'remember',description:'Save memory',inputSchema:{type:'object',properties:{note:{type:'string'}},required:['note']}}]})
    await store!.claim(userId,deviceId)
    for (const note of ['first','second']) await store!.submit(userId,deviceId,turnId,{type:'tool',callId:note,name:'remember',input:{note}})
    const effects: string[]=[]
    await assert.rejects(nativeCoordinatorTurn(userId,holder,0,runtime,scope => ({remember:tool({
      inputSchema:z.object({note:z.string()}),execute:async ({note}) => {
        await assertNativeToolScope(userId,scope)
        effects.push(note)
        if (revoked === 'device') await pool!.query('UPDATE devices SET enabled=false WHERE id=$1',[deviceId])
        else if (revoked === 'lease') await pool!.query('UPDATE coordinator_sessions SET "leaseHolder"=null WHERE "userId"=$1',[userId])
        else if (revoked === 'deadline') await pool!.query('UPDATE native_coordinator_turns SET "expiresAt"=now() WHERE id=$1',[turnId])
        else if (revoked === 'failed') await store!.submit(userId,deviceId,turnId,{type:'failed'})
        else await store!.close(userId,holder,turnId)
        return {remembered:true}
      },
    })}),COORDINATOR_BOT),/ExpiredOrLeaseLost/)
    assert.deepEqual(effects,['first'])
  })
}
