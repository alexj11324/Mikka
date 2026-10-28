import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { credentialAwareExecutor, type CredentialIntent, type LiveCredentialLease } from './subagent-credential-callback'

const driver = { installed: true as const, version: 'synthetic', path: '/synthetic', fingerprint: 'driver' }
const call = { name: 'click', arguments: { x: 10, y: 20 } }
function fixture() {
  const intent: CredentialIntent = { actionId: 'action', runId: 'run', userId: 'owner', workspaceId: 'workspace', botId: 'bot', subagentId: 'subagent', epoch: 2, display: ':1', policyVersion: 3, driverFingerprint: driver.fingerprint, callDigest: createHash('sha256').update(JSON.stringify(call)).digest('hex'), expiresAt: Date.now() + 60_000, targetId: 'target', origin: 'https://example.test', loaderId: 'document', backendNodeId: 42, role: 'username' }
  const state = { pending: true, version: 3, running: true }
  const fill = vi.fn(async () => ({ status: 'session_applied', private: 'synthetic' }))
  const ordinary = vi.fn(async () => ({ ordinary: true }))
  const execute = credentialAwareExecutor({
    consumeMatchingIntent: async () => { if (!state.pending) return { kind: 'consumed' }; state.pending = false; return { kind: 'credential', intent } },
    withCurrentLease: async (value, action) => { const live: LiveCredentialLease = { ...value, running: state.running, policyVersion: state.version }; return action(live) },
    executeCredential: fill,
    executeOrdinary: ordinary,
  })
  return { execute, state, fill, ordinary }
}

describe('credential broker execution callback', () => {
  it('consumes the host action and returns only a bounded outcome', async () => {
    const { execute, fill, ordinary } = fixture()
    expect(await execute(driver, call, ':1', 'run', { actionId: 'action' })).toEqual({ status: 'session_applied' })
    await expect(execute(driver, call, ':1', 'run', { actionId: 'action' })).rejects.toThrow('already consumed')
    expect(fill).toHaveBeenCalledTimes(1); expect(ordinary).not.toHaveBeenCalled()
  })
  it('does not fill after policy revision or STOP', async () => {
    for (const mode of ['version', 'stop'] as const) {
      const { execute, state, fill } = fixture()
      if (mode === 'version') state.version++
      else state.running = false
      await expect(execute(driver, call, ':1', 'run', { actionId: 'action' })).rejects.toThrow('unavailable')
      expect(fill).not.toHaveBeenCalled()
    }
  })
  it('rejects a mismatched broker action identity before filling', async () => {
    const { execute, fill } = fixture()
    await expect(execute(driver, call, ':1', 'run', { actionId: 'other' })).rejects.toThrow('unavailable')
    expect(fill).not.toHaveBeenCalled()
  })
})
