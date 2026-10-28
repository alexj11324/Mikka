import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeCredentialIntent } from './credential-consumer'

test('credential operation fails closed without trusted policy and broker integration', async () => {
  await assert.rejects(executeCredentialIntent({ permissionAction: 'computer_use', actor: { userId: 'owner', workspaceId: 'workspace' }, botId: 'bot', subagentId: 'subagent', epoch: 1, loaderId: 'document', origin: 'https://example.test', backendNodeId: 10, intent: { targetSelector: '[data-mikka-ref="0"]', role: 'username' } }), { status: 503 })
})
