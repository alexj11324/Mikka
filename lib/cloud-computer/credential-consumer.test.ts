import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeCredentialIntent } from './credential-consumer'

test('credential operation fails closed without trusted policy and broker integration', async () => {
  await assert.rejects(executeCredentialIntent({ permissionAction: 'computer_use', actor: { userId: 'owner', workspaceId: 'workspace' }, botId: 'bot', subagentId: 'subagent', epoch: 1, loaderId: 'document', origin: 'https://example.test', intent: { action: 'fill_login', targetSelector: '[data-mikka-ref="0"]' } }), { status: 503 })
})
