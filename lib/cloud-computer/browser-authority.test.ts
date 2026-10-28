import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeBrowserAction, verifyBrowserApproval } from './browser-authority'

test('missing host authority never grants or replays a browser mutation', async () => {
  const base = { actor: { userId: 'owner', workspaceId: 'workspace' }, botId: 'bot', subagentId: 'subagent', epoch: 1, loaderId: 'document', origin: 'https://example.test', mutation: { action: 'click' as const, selector: '#submit' } }
  await assert.rejects(authorizeBrowserAction(base), { status: 503 })
  await assert.rejects(verifyBrowserApproval({ ...base, actionId: 'review', policyVersion: 1, expiresAt: Date.now() + 1000, digest: 'digest' }), { status: 503 })
})
