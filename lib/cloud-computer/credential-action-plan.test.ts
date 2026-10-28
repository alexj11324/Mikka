import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { parseCredentialAction, recordCredentialAction } from './credential-action-ledger'

const subagentId = randomUUID()
const binding = { userId: 'fixture-owner', workspaceId: randomUUID(), botId: randomUUID(), subagentId, runId: subagentId, epoch: 1, policyVersion: 3, targetId: 'target', loaderId: 'document', origin: 'https://example.test', backendNodeId: 1, role: 'username' as const, additionalInput: { backendNodeId: 2, role: 'password' as const }, submitNodeId: 3, expiresAt: Date.now() + 60000 }
const pool = { async query() { return { rows: [{ id: 'recorded' }], rowCount: 1 } } } as never

test('one existing approval receipt binds both model-selected inputs and submission', async () => {
  const { action } = await recordCredentialAction(pool, binding, 'ask', false, randomUUID())
  assert.equal(action.summary, 'Fill username and password and submit on example.test')
  assert.deepEqual(parseCredentialAction(action), action)
  // PostgreSQL jsonb changes key ordering. It must not change the meaning of
  // the selected input or invalidate an otherwise identical receipt.
  assert.doesNotThrow(() => parseCredentialAction({ ...action, additionalInput: { role: 'password', backendNodeId: 2 } }))
  for (const changed of [{ ...action, submitNodeId: 4 }, { ...action, additionalInput: { backendNodeId: 4, role: 'password' as const } }, { ...action, role: 'password' as const }]) {
    assert.throws(() => parseCredentialAction(changed))
  }
})
test('deny, readonly, duplicate fields and an input used as submit are rejected before recording', async () => {
  for (const [decision, readOnly, input] of [
    ['deny', false, binding], ['allow', true, binding],
    ['allow', false, { ...binding, additionalInput: { backendNodeId: 2, role: 'username' as const } }],
    ['allow', false, { ...binding, additionalInput: { backendNodeId: 1, role: 'password' as const } }],
    ['allow', false, { ...binding, submitNodeId: 2 }],
  ] as const) await assert.rejects(recordCredentialAction(pool, input, decision, readOnly, randomUUID()))
})
