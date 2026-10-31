import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import pg from 'pg'
import { createApprovedWrites } from './approved-writes'
import { createOperationLedger, type OperationIntent } from './ledger'
import { DEFAULT_AGENT_DEFINITION } from '../agent-kit/builtin'
import { digest, makeSnapshot } from '../agent-kit/definition'
import { recoveryHttpProvider } from '../../tests/fixtures/operation-recovery'
import { validateTarget } from '../../scripts/run-db-tests.mjs'

const action = 'append_notion_paragraph'
const fixtureFile = fileURLToPath(new URL('../../tests/fixtures/operation-recovery.ts', import.meta.url))
const preload = fileURLToPath(new URL('../../tests/support/server-only.mjs', import.meta.url))

function message(child: ChildProcess, kind: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(Error(`fixture ${kind} deadline`)), 10_000)
    const receive = (value: Record<string, string>) => { if (value?.kind === kind) finish(undefined, value) }
    const failed = () => finish(Error(`fixture exited before ${kind}`))
    const finish = (error?: Error, value?: Record<string, string>) => {
      clearTimeout(timer); child.off('message', receive); child.off('exit', failed)
      if (error) reject(error); else resolve(value!)
    }
    child.on('message', receive); child.once('exit', failed)
  })
}
function child(mode: 'server' | 'worker', env: Partial<NodeJS.ProcessEnv> = {}) {
  return fork(fixtureFile, [mode], { execArgv: ['--import', preload, '--import', 'tsx'], env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
}
async function stop(process: ChildProcess) {
  if (process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, 'exit')
  process.kill('SIGKILL')
  await exited
}
async function fixture() {
  validateTarget(process.env)
  assert.equal(process.env.REQUIRE_DB, '1')
  const schema = 'operation208_' + randomUUID().replaceAll('-', '')
  const admin = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1 })
  let pool: pg.Pool | undefined, server: ChildProcess | undefined
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const ownedPool = pool = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, options: `-c search_path=${schema},pg_catalog`, max: 12 })
    await ownedPool.query(`CREATE TABLE "session" (id text primary key,"userId" text not null,"expiresAt" timestamptz not null);
      CREATE TABLE agent_kit_heads (owner_id text,bot_key text,workspace_id uuid,active_version uuid,PRIMARY KEY(owner_id,bot_key));
      CREATE TABLE agent_kit_versions(owner_id text,bot_key text,id uuid,definition jsonb,digest text);
      CREATE TABLE agent_kit_executions(owner_id text,bot_key text,id uuid,status text,snapshot jsonb,version_id uuid)`)
    for (const name of ['20261025043000_pending_actions.sql', '20261028143920_operation_ledger.sql', '20261028143921_approved_write_binding.sql', '20261029043646_agent_external_write_policy.sql']) {
      await ownedPool.query(await readFile(new URL('../../drizzle/' + name, import.meta.url), 'utf8'))
    }
    const ownedServer = server = child('server')
    const { origin } = await message(ownedServer, 'ready')
    console.log(`Retained operation recovery schema ${schema}; loopback effect process ${origin}`)
    return { schema, pool: ownedPool, origin, async close() { await stop(ownedServer); await ownedPool.end(); await admin.end() } }
  } catch (error) {
    await Promise.allSettled([server && stop(server), pool?.end(), admin.end()])
    throw error
  }
}

test('ten concurrent callers and a new run retain one logical operation and effect', { timeout: 30_000 }, async () => {
  const f = await fixture()
  try {
    const provider = recoveryHttpProvider(f.origin)
    const run = randomUUID(), id = randomUUID()
    const binding: OperationIntent = { operationId: id, ownerId: 'owner', workspaceId: 'personal:owner', provider: provider.name, accountId: 'fixture-account', action, target: 'owned-target', approvalId: id, proposalDigest: 'a'.repeat(64), payloadDigest: 'b'.repeat(64) }
    const key = { operationId: id, ownerId: binding.ownerId, workspaceId: binding.workspaceId }
    const authorize = async (_tx: pg.PoolClient, intent: OperationIntent) => {
      if (intent.ownerId !== binding.ownerId || intent.workspaceId !== binding.workspaceId || intent.approvalId !== id) throw Error('fixture authority denied')
    }
    const ledger = createOperationLedger(f.pool, authorize)
    const reservations = await Promise.all(Array.from({ length: 10 }, () => ledger.reserve(binding)))
    assert.equal(new Set(reservations.map(row => row.idempotencyKey)).size, 1)
    const claims = await Promise.allSettled(Array.from({ length: 10 }, () => ledger.claim(key, run)))
    const winner = claims.filter((row): row is PromiseFulfilledResult<Awaited<ReturnType<typeof ledger.claim>>> => row.status === 'fulfilled')
    assert.equal(winner.length, 1)
    const pending = await ledger.reconcile(key, record => provider.lookup({ ownerId: binding.ownerId, accountId: binding.accountId, idempotencyKey: record.idempotencyKey }))
    assert.equal(pending.status, 'executing', 'a negative lookup must not invalidate the winner before its first invocation')
    await ledger.invoke(key, winner[0].value.attemptToken!, async (row, beforeSend, signal) => provider.execute({ ownerId: binding.ownerId, accountId: binding.accountId, version: 'fixture-v1', payload: {}, approvalContext: null, idempotencyKey: row.idempotencyKey, beforeSend, signal }))
    const restarted = createOperationLedger(f.pool, authorize)
    assert.equal((await restarted.reserve(binding)).status, 'succeeded')
    await assert.rejects(restarted.claim(key, randomUUID()), /operationAlreadyClaimed/)
    await assert.rejects(restarted.reserve({ ...binding, payloadDigest: 'c'.repeat(64) }), /operationBindingConflict/)
    await assert.rejects(restarted.read({ ...key, ownerId: 'other' }), /operationUnavailable/)
    assert.deepEqual(await (await fetch(f.origin + '/stats')).json(), { posts: 1, effects: 1 })
    assert.equal(Number((await f.pool.query('SELECT count(*) FROM operation_ledger')).rows[0].count), 1)
  } finally { await f.close() }
})

test('an authorized human can read back an effect after its worker dies and execution fails', { timeout: 30_000 }, async () => {
  const f = await fixture()
  let worker: ChildProcess | undefined
  try {
    const run = randomUUID(), revision = randomUUID(), intentKey = randomUUID(), page = randomUUID()
    const ownerId = 'recovery-owner', actor = { userId: ownerId, sessionId: 'recovery-session' }
    const definition = { ...DEFAULT_AGENT_DEFINITION, tools: [action] }
    const snapshot = makeSnapshot(revision, 1, definition, 'controlled local fixture', { harness: 'ai_sdk', model: 'openai/gpt-6-luna' })
    await f.pool.query('INSERT INTO "session" VALUES($1,$2,now()+interval \'1 hour\')', [actor.sessionId, ownerId])
    await f.pool.query('INSERT INTO agent_kit_heads(owner_id,bot_key,active_version,external_write_permissions) VALUES($1,\'coordinator\',$2,$3)', [ownerId, revision, { [action]: 'allow' }])
    await f.pool.query('INSERT INTO agent_kit_versions VALUES($1,\'coordinator\',$2,$3,$4)', [ownerId, revision, definition, digest(definition)])
    await f.pool.query('INSERT INTO agent_kit_executions VALUES($1,\'coordinator\',$2,\'running\',$3,$4)', [ownerId, run, snapshot, revision])
    worker = child('worker', { OPERATION_RECOVERY_SCHEMA: f.schema, OPERATION_RECOVERY_ORIGIN: f.origin, OPERATION_RECOVERY_RUN: run, OPERATION_RECOVERY_PAGE: page, OPERATION_RECOVERY_INTENT: intentKey })
    await message(worker, 'effect-applied')
    await stop(worker)
    await f.pool.query("UPDATE agent_kit_executions SET status='failed' WHERE id=$1", [run])
    const before = (await f.pool.query('SELECT * FROM operation_ledger')).rows[0]
    assert.equal(before.status, 'executing')
    assert.ok(before.invokedAt)
    const proposal = (await f.pool.query('SELECT id FROM pending_actions')).rows[0]
    let lookups = 0
    const provider = recoveryHttpProvider(f.origin)
    const service = createApprovedWrites(f.pool, { ...provider, lookup: async input => { lookups++; return provider.lookup(input) } }, action)
    await assert.rejects(service.decide({ ...actor, userId: 'other' }, proposal.id, true))
    await f.pool.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [actor.sessionId])
    await assert.rejects(service.decide(actor, proposal.id, true), /operationSessionUnavailable/)
    await f.pool.query('UPDATE "session" SET "expiresAt"=now()+interval \'1 hour\' WHERE id=$1', [actor.sessionId])
    assert.equal(lookups, 0)
    let guardedLookups = 0
    const guarded = createOperationLedger(f.pool, async () => {}, { guard: async () => { throw Error('fixtureMembershipRevoked') } })
    await assert.rejects(guarded.reconcile({ operationId: before.operationId, ownerId, workspaceId: `personal:${ownerId}` }, async () => { guardedLookups++; return null }), /fixtureMembershipRevoked/)
    assert.equal(guardedLookups, 0, 'membership lease must precede remote readback')
    const result = await service.decide(actor, proposal.id, true)
    assert.equal(result.status, 'done')
    const after = (await f.pool.query('SELECT * FROM operation_ledger')).rows[0]
    assert.equal(after.operationId, before.operationId)
    assert.equal(after.idempotencyKey, before.idempotencyKey)
    assert.equal(after.runId, run)
    assert.equal(after.binding.executionRunId, run)
    assert.equal(after.status, 'succeeded')
    assert.equal((await service.decide(actor, proposal.id, true)).status, 'done')
    assert.equal(lookups, 1)
    const newRun = randomUUID()
    const retry = createApprovedWrites(f.pool, provider, action, { modelRun: { ownerId, botId: null, workspaceId: null, runId: newRun } })
    await assert.rejects(retry.proposeFromRun({ page_id: page, text: 'Controlled local recovery effect' }, intentKey), /operationBindingConflict/)
    const endedWorker = createApprovedWrites(f.pool, provider, action, { modelRun: { ownerId, botId: null, workspaceId: null, runId: run } })
    await assert.rejects(endedWorker.proposeFromRun({ page_id: page, text: 'Controlled local recovery effect' }, intentKey), /writeRunUnavailable/)
    const ledger = createOperationLedger(f.pool, async () => {})
    await assert.rejects(ledger.claim({ operationId: after.operationId, ownerId, workspaceId: `personal:${ownerId}` }, randomUUID()), /operationRunMismatch/)
    await f.pool.query('UPDATE agent_kit_heads SET external_write_permissions=$1 WHERE owner_id=$2', [{ [action]: 'deny' }, ownerId])
    await assert.rejects(service.decide(actor, proposal.id, true), /writeDenied/)
    assert.equal(lookups, 1)
    assert.deepEqual(await (await fetch(f.origin + '/stats')).json(), { posts: 1, effects: 1 })
  } finally { if (worker) await stop(worker); await f.close() }
})
