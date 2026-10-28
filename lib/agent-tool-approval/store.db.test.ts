import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { AgentToolApprovalStore } from './store'

const url = process.env.APPROVAL_TEST_DATABASE_URL
if (!url) throw new Error('An isolated local approval_e2e database is required')
const target = new URL(url)
if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || target.pathname !== '/approval_e2e') throw new Error('Refusing non-isolated database')
const pool = new Pool({ connectionString: url })
const store = new AgentToolApprovalStore(pool)
const runId = randomUUID(), deviceId = randomUUID(), actor = { userId: 'synthetic-owner', deviceId }
const payload = (requestId: string) => ({ runId, requestId, harness: 'codex' as const, method: 'item/commandExecution/requestApproval', input: { command: 'synthetic' } })
before(async () => {
  await pool.query(`CREATE TABLE agent_runs (id uuid PRIMARY KEY, "userId" text NOT NULL, "deviceId" uuid NOT NULL, status text NOT NULL, "stopRequestedAt" timestamptz, "leaseExpiresAt" timestamptz, "agentId" uuid NOT NULL, "agentDefinition" jsonb)`)
  await pool.query(`CREATE TABLE agents (id uuid PRIMARY KEY, "userId" text NOT NULL, harness text NOT NULL); CREATE TABLE devices (id uuid PRIMARY KEY, "ownerId" text NOT NULL, enabled boolean NOT NULL)` )
  await pool.query(await readFile('drizzle/20261028210100_agent_tool_approvals.sql', 'utf8'))
  const agentId = randomUUID()
  await pool.query(`INSERT INTO agents VALUES ($1,$2,'codex')`, [agentId,actor.userId])
  await pool.query(`INSERT INTO devices VALUES ($1,$2,true)`, [deviceId,actor.userId])
  await pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,'running',NULL,now()+interval '5 minutes',$4,NULL)`, [runId,actor.userId,deviceId,agentId])
})
after(async () => { await pool.end() })
test('pending, owner decision, exactly one consumer, and scope isolation', async () => {
  const proposal = await store.propose(actor, payload('one'))
  assert.equal(await store.take(actor, runId, proposal.id, proposal.digest), 'pending')
  assert.equal((await store.list(actor.userId, runId)).length, 1)
  assert.equal((await store.list('other', runId)).length, 0)
  await assert.rejects(store.decide('other', runId, proposal.id, proposal.digest, 'approve'))
  await assert.rejects(store.decide(actor.userId, runId, proposal.id, 'bad', 'approve'))
  await store.decide(actor.userId, runId, proposal.id, proposal.digest, 'approve')
  const decisions = await Promise.all([store.take(actor, runId, proposal.id, proposal.digest), store.take(actor, runId, proposal.id, proposal.digest)])
  assert.deepEqual(decisions.sort(), ['allow', 'deny'])
  await assert.rejects(store.decide(actor.userId, runId, proposal.id, proposal.digest, 'approve'))
  await assert.rejects(store.propose(actor, { ...payload('one'), input: { command: 'different' } }))
  await assert.rejects(store.take({ ...actor, deviceId: randomUUID() }, runId, proposal.id, proposal.digest))
})
test('deny, cancellation and stopped run never authorize', async () => {
  const denied = await store.propose(actor, payload('denied'))
  await store.decide(actor.userId, runId, denied.id, denied.digest, 'deny')
  assert.equal(await store.take(actor, runId, denied.id, denied.digest), 'deny')
  const cancelled = await store.propose(actor, payload('cancel'))
  await store.decide(actor.userId, runId, cancelled.id, cancelled.digest, 'approve')
  assert.equal(await store.cancel(actor, runId, cancelled.id, cancelled.digest), true)
  assert.equal(await store.take(actor, runId, cancelled.id, cancelled.digest), 'deny')
  const stopped = await store.propose(actor, payload('stop'))
  await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
  await assert.rejects(store.decide(actor.userId, runId, stopped.id, stopped.digest, 'approve'))
  await assert.rejects(store.take(actor, runId, stopped.id, stopped.digest))
})
