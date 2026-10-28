import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorizeBrowserAction, executeAuthorizedBrowserNavigation, executeAuthorizedBrowserAction, executeReviewedBrowserAction } from './browser-authority'

test('missing host authority never grants or replays a browser mutation', async () => {
  const base = { permissionAction: 'computer_use' as const, actor: { userId: 'owner', workspaceId: 'workspace' }, botId: 'bot', subagentId: 'subagent', epoch: 1, loaderId: 'document', origin: 'https://example.test', mutation: { action: 'click' as const, selector: '#submit' }, summary: 'Submit' }
  await assert.rejects(authorizeBrowserAction(base), { status: 503 })
  await assert.rejects(executeAuthorizedBrowserNavigation({ ...base, url: 'https://example.test' }), { status: 503 })
  await assert.rejects(executeAuthorizedBrowserAction({ ...base, policyVersion: 1, expiresAt: Date.now() + 1000 }), { status: 503 })
  await assert.rejects(executeReviewedBrowserAction({ ...base, actionId: 'review', policyVersion: 1, expiresAt: Date.now() + 1000, digest: 'digest' }), { status: 503 })
})
