import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { credentialAwareExecutor, type CredentialIntent } from '../packages/daemon/src/computer/credential-executor'

test('trusted executor preserves guarded intermediate state without forwarding service data', async () => {
  const call = { name: 'click', arguments: { x: 1, y: 2 } }
  const driver = { installed: true as const, version: 'fixture', path: '/fixture', fingerprint: 'f'.repeat(64) }
  const intent: CredentialIntent = { actionId: 'action', runId: 'run', userId: 'owner', workspaceId: 'workspace', botId: 'bot', subagentId: 'subagent', epoch: 1, display: ':2', policyVersion: 1, driverFingerprint: driver.fingerprint, callDigest: createHash('sha256').update(JSON.stringify(call)).digest('hex'), expiresAt: Date.now() + 10000, targetId: 'target', origin: 'https://example.test', loaderId: 'loader', backendNodeId: 1, role: 'password' }
  let liveChecks = 0
  const execute = credentialAwareExecutor({
    consumeMatchingIntent: async () => ({ kind: 'credential', intent }),
    withCurrentLease: async (_intent, action) => action({ ...intent, running: true }),
    executeCredential: async (_intent, assertLive) => { assertLive(); return { status: 'guarded', guardToken: 'synthetic-private-token' } },
    executeOrdinary: async () => { throw new Error('unexpected ordinary operation') },
  })
  assert.deepEqual(await execute(driver, call, ':2', 'run', { actionId: 'action', assertLive() { liveChecks++ } }), { status: 'guarded' })
  assert(liveChecks >= 3)
})
