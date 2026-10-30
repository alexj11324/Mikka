import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Pool } from 'pg'
import { nativeSessionSnapshot } from '../lib/ci-native-session-store'

// Run only against the caller-created, isolated fixture database. Rows are
// deliberately retained for inspection; no cleanup is performed.
test('native snapshot is encrypted, scoped, and fenced against revocation', async () => {
  const url = process.env.CI_NATIVE_RETAINED_DATABASE_URL
  if (!url || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/mikka_ci_native') throw new Error('isolated retained fixture required')
  const db = new Pool({ connectionString: url })
  const [origin, child, device, issue, agent, binding, connection] = Array.from({length: 7}, () => crypto.randomUUID())
  const owner = `synthetic-${crypto.randomUUID()}`, workspace = crypto.randomUUID()
  const definition = JSON.stringify({definitionDigest:'synthetic-digest'})
  const base = {ownerId: owner,deviceId: device,accountId:'synthetic-account',revision:1,route:'codex_cli',modelId:'synthetic-model'}
  const secret = 'synthetic-session-key-at-least-32-bytes'
  await db.query(`INSERT INTO byos_connections VALUES ($1,$2,$3,1,'connected')`,[connection,owner,workspace])
  await db.query(`INSERT INTO byos_bindings VALUES ($1,$2,$3,$4,$5,1,'codex_cli','synthetic-model',now())`,[binding,owner,workspace,agent,connection])
  await db.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,'synthetic-session',NULL,$5,$6,'running',now()+interval '1 hour',NULL)`,[origin,owner,device,issue,agent,definition])
  await db.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,$4,NULL,$5,$6,$7,'running',now()+interval '1 hour',NULL)`,[child,owner,device,issue,JSON.stringify({originRunId:origin,originSessionId:'synthetic-session',requireSessionResume:true}),agent,definition])
  await db.query('INSERT INTO byos_native_runs VALUES ($1,$2),($3,$2)',[origin,binding,child])
  const plain = Buffer.from('synthetic native conversation')
  await nativeSessionSnapshot(db,{...base,runId:origin},{kind:'save',sessionId:'synthetic-session',data:plain},secret)
  const {rows:[stored]} = await db.query('SELECT ciphertext FROM ci_native_sessions WHERE "runId"=$1',[origin])
  assert.equal(stored.ciphertext.includes(plain),false)
  assert.deepEqual(await nativeSessionSnapshot(db,{...base,runId:child},{kind:'restore'},secret),plain)
  await assert.rejects(nativeSessionSnapshot(db,{...base,runId:child,accountId:'other-account'},{kind:'restore'},secret))
  const revocation = await db.connect()
  await revocation.query('BEGIN')
  await revocation.query(`UPDATE byos_connections SET state='disconnected',epoch=2 WHERE id=$1`,[connection])
  let settled = false
  const restoring = nativeSessionSnapshot(db,{...base,runId:child},{kind:'restore'},secret).finally(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve,100))
  assert.equal(settled,false, 'restore must wait for concurrent revocation')
  await revocation.query('COMMIT')
  revocation.release()
  await assert.rejects(restoring)
  await db.end()
})
