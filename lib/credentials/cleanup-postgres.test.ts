import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { CredentialBroker } from './broker'
import { PostgresCredentialAuthority } from './authority'

// Isolated fixture database only. No provider credentials or production data.
test('cleanup persists tombstones, retries deletion and serializes concurrent sweeps in PostgreSQL', async () => {
  const url = process.env.CLEANER_TEST_DATABASE_URL
  assert.ok(url, 'CLEANER_TEST_DATABASE_URL is required; this test must not silently skip')
  const target = new URL(url)
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname) && target.pathname.endsWith('_e2e'))
  const schema = 'cleaner_' + randomUUID().replaceAll('-', '')
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 8 })
  try {
    await pool.query(`CREATE TABLE credential_requests (
      id uuid PRIMARY KEY, owner_id text NOT NULL, workspace_id uuid NOT NULL, task_id uuid NOT NULL,
      run_id uuid NOT NULL, execution_session text NOT NULL, auth_session_id text NOT NULL,
      service_id text NOT NULL, service_policy_hash text NOT NULL, target_origin text NOT NULL,
      mode text NOT NULL, state text NOT NULL, nonce_hash text NOT NULL, vault_ref uuid NOT NULL UNIQUE,
      retention text NOT NULL, expires_at timestamptz NOT NULL, use_expires_at timestamptz,
      cleanup_pending boolean NOT NULL, version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE agent_runs(id uuid, "issueId" uuid,"sessionId" text,"deviceId" uuid,"userId" text,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz);
      CREATE TABLE issues(id uuid,content text,"userId" text);
      CREATE TABLE devices(id uuid,"ownerId" text,enabled boolean,"lastSeenAt" timestamptz);
      CREATE TABLE "user"(id text); CREATE TABLE "session"(id text,"userId" text,"expiresAt" timestamptz);`)
    const ids = [randomUUID(),randomUUID(),randomUUID()]
    for (let i=0;i<ids.length;i++) await pool.query(`INSERT INTO credential_requests
      (id,owner_id,workspace_id,task_id,run_id,execution_session,auth_session_id,service_id,service_policy_hash,target_origin,mode,state,nonce_hash,vault_ref,retention,expires_at,cleanup_pending)
      VALUES($1,'synthetic-no-owner',$1,$1,$1,'no-executor','no-session','fixture','fixture','https://fixture.invalid','api_header',$2,'fixture',$1,'once',now()+$3::interval,$4)`,
      [ids[i],i===2?'failed':'ready',i===0?'-1 minute':'1 hour',i===2])
    const values = new Set<string>(ids); const deletes = new Map<string,number>(); let failThird=true
    const broker = new CredentialBroker({ pool, authority:new PostgresCredentialAuthority(pool,pool), services:new Map(), vault:{
      put:async()=>{throw Error('admission forbidden')}, read:async()=>{throw Error('secret read forbidden')},
      remove:async id=>{deletes.set(id,(deletes.get(id)??0)+1); if(id===ids[2]&&failThird)throw Error('synthetic transport failure');values.delete(id)},
    } })
    assert.deepEqual(await broker.sweep(),{checked:3})
    const first=(await pool.query('SELECT id,state,cleanup_pending FROM credential_requests ORDER BY id')).rows
    assert.equal(first.find(r=>r.id===ids[0]).state,'expired')
    assert.equal(first.find(r=>r.id===ids[1]).state,'disconnected')
    assert.equal(first.find(r=>r.id===ids[2]).cleanup_pending,true)
    assert.equal(values.size,1)
    failThird=false
    await Promise.all([broker.sweep(),broker.sweep()])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM credential_requests WHERE cleanup_pending')).rows[0].n,0)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM credential_requests')).rows[0].n,3)
    assert.equal(values.size,0)
    await broker.sweep()
    assert.ok(ids.every(id=>(deletes.get(id)??0)>=2),'retained tombstones repeat exact idempotent deletion')
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end() }
})
