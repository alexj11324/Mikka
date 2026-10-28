import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { recordCredentialAction, consumeCredentialAction, withCredentialActionFence, type CredentialActionBinding } from './credential-action-ledger'

function fixture() {
  const rows = new Map<string, { user: string; input: string; status: string }>()
  const pool = { async query(sql: string, values: unknown[]) {
    const [id, user] = values as string[]
    if (sql.startsWith('INSERT')) { rows.set(id, { user, input: String(values[3]), status: String(values[4]) }); return { rowCount: 1 } }
    const row = rows.get(id)
    if (!row || row.user !== user || row.status !== 'running' || row.input !== values[2]) return { rowCount: 0 }
    row.status = 'claimed'; return { rowCount: 1 }
  } }
  const webRun = randomUUID()
  const binding: CredentialActionBinding = { userId: 'owner', workspaceId: randomUUID(), botId: randomUUID(), subagentId: webRun, runId: webRun, epoch: 1, policyVersion: 2, targetId: 'target', origin: 'https://example.test', loaderId: 'loader', backendNodeId: 42, role: 'password', expiresAt: Date.now() + 60_000 }
  return { pool: pool as never, binding, rows }
}

test('allow creates a one-use action and consumes it before I/O', async () => {
  const { pool, binding, rows } = fixture()
  const { action } = await recordCredentialAction(pool, binding, 'allow', false, randomUUID())
  assert.equal(rows.get(action.actionId)?.status, 'running')
  await consumeCredentialAction(pool, action)
  assert.equal(rows.get(action.actionId)?.status, 'claimed')
  await assert.rejects(consumeCredentialAction(pool, action), { status: 409 })
})

test('ask uses pending action; it cannot be consumed before the existing decision', async () => {
  const { pool, binding, rows } = fixture()
  const { action } = await recordCredentialAction(pool, binding, 'ask', false, randomUUID())
  assert.equal(rows.get(action.actionId)?.status, 'pending')
  await assert.rejects(consumeCredentialAction(pool, action), { status: 409 })
  rows.get(action.actionId)!.status = 'running'
  await consumeCredentialAction(pool, action)
  await assert.rejects(consumeCredentialAction(pool, action), { status: 409 })
})

test('deny, read-only, changed binding and expiry cannot create or claim a receipt', async () => {
  const { pool, binding, rows } = fixture()
  await assert.rejects(recordCredentialAction(pool, binding, 'deny', false, randomUUID()), { status: 403 })
  await assert.rejects(recordCredentialAction(pool, binding, 'allow', true, randomUUID()), { status: 403 })
  await assert.rejects(recordCredentialAction(pool, { ...binding, expiresAt: Date.now() - 1 }, 'allow', false, randomUUID()), { status: 403 })
  const { action } = await recordCredentialAction(pool, binding, 'allow', false, randomUUID())
  for (const changed of [{ userId: 'other' }, { targetId: 'other' }, { policyVersion: 3 }, { role: 'username' as const }, { runId: randomUUID() }]) await assert.rejects(consumeCredentialAction(pool, { ...action, ...changed }), { status: 403 })
  assert.equal(rows.get(action.actionId)?.status, 'running')
})

test('fence rejects stopped runs, revoked policy and changed versions before service I/O', async () => {
  const { pool, binding } = fixture()
  const { action } = await recordCredentialAction(pool, binding, 'allow', false, randomUUID())
  let state: Record<string, unknown> | undefined = { sandboxId: 'fixture', permission: 'allow', version: 2 }
  const calls: string[] = []
  const client = { async query(sql: string) {
    calls.push(sql)
    if (sql.includes('FROM pending_actions a')) return { rows: state ? [state] : [] }
    return { rows: [] }
  }, release() { calls.push('release') } }
  const fencedPool = { async connect() { return client }, async query() { return { rowCount: 1 } } } as never
  let invoked = 0
  const run = () => withCredentialActionFence(fencedPool, action, async id => { assert.equal(id, 'fixture'); invoked++; return 'ok' })
  assert.equal(await run(), 'ok')
  assert(calls.some(sql => sql.includes('pg_advisory_xact_lock')))
  for (state of [undefined, { sandboxId: 'fixture', permission: 'deny', version: 2 }, { sandboxId: 'fixture', permission: 'ask', version: 3 }]) await assert.rejects(run(), { status: 403 })
  assert.equal(invoked, 1)
})
