import assert from 'node:assert/strict'
import test from 'node:test'
import { approvedWriteDecisionEvent } from './write-notice'
import type { StoredWriteProposal } from './approved-writes'
import { snapshotDigest } from './write-target'

const botId = '00000000-0000-4000-8000-000000000001'
const input = { channel: 'C12345678', text: 'Controlled fixture' }
const proposal: StoredWriteProposal = {
  id: '00000000-0000-4000-8000-000000000002', userId: 'owner', action: 'send_slack_message', input, status: 'running',
  intentKey: '00000000-0000-4000-8000-000000000003', context: null, createdAt: new Date(),
  operationBinding: { provider: 'composio-slack', accountId: 'account', version: 'slack-message-metadata-v1', payloadDigest: snapshotDigest(input), contextDigest: snapshotDigest(null), run: {
    runId: '00000000-0000-4000-8000-000000000004', botId, workspaceId: null, policyVersion: '0', decision: 'ask',
  } },
}

test('an approved-write result routes to the originating Bot with the actual provider object receipt', () => {
  const outcome = { id: '123.456', url: 'https://fixture.slack.com/archives/C12345678/p123456' }
  const event = approvedWriteDecisionEvent(proposal, { status: 'done', error: null, outcome })
  assert.equal(event.userId, 'owner'); assert.equal(event.botId, botId)
  assert.equal(event.runId, null, 'an agent-kit execution id is not an agent_runs id')
  assert.equal(event.kind, 'action_decided')
  assert.deepEqual(event.payload.outcome, outcome)
  assert.equal(event.payload.status, 'done')
  assert.equal(JSON.stringify(event).includes('operationBinding'), false)
})

test('an early uncertain notice cannot deduplicate away a later verified result', () => {
  const unknown = approvedWriteDecisionEvent(proposal, { status: 'running', error: 'operationUncertain' })
  const done = approvedWriteDecisionEvent(proposal, { status: 'done', error: null, outcome: { id: '123.456' } })
  assert.notEqual(unknown.dedupeKey, done.dedupeKey)
  assert.deepEqual(unknown.payload.outcome, {})
  assert.equal(done.dedupeKey, approvedWriteDecisionEvent(proposal, { status: 'done', error: null, outcome: { id: '123.456' } }).dedupeKey)
  const personal = { ...proposal, operationBinding: { ...proposal.operationBinding, run: undefined } }
  assert.equal(approvedWriteDecisionEvent(personal, { status: 'declined', error: null }).botId, null)
})
