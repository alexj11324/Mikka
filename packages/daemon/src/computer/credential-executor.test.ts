import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ComputerBroker } from './broker.mjs'
import { createHostedComputerExecutor, type CredentialIntent, type CredentialExecutorAuthority } from './credential-executor'
import { cleanupTempDirs, tempDir } from '../../test/helpers'

afterEach(cleanupTempDirs)
it.each(['allow', 'ask'] as const)('host broker invokes credential executor with %s action identity and a live fence', async permission => {
  const driver = { installed: true as const, version: 'fixture', path: '/fixture', fingerprint: 'f'.repeat(64) }
  let active = true, executions = 0, seen = '', fence = false
  const authority: CredentialExecutorAuthority = {
    async consumeMatchingIntent(runId, actionId, digest) {
      seen = actionId
      return { kind: 'credential', intent: { actionId, runId, userId: 'owner', workspaceId: 'workspace', botId: 'bot', subagentId: 'sub', epoch: 1, display: ':2', policyVersion: 3, driverFingerprint: driver.fingerprint, callDigest: digest, expiresAt: Date.now() + 10000, targetId: 'target', origin: 'https://example.test', loaderId: 'loader', backendNodeId: 7, role: 'password' } }
    },
    async withCurrentLease(intent, action) { fence = true; try { return await action({ ...intent, running: active }) } finally { fence = false } },
    async executeCredential(intent) { expect(fence).toBe(true); expect(intent.actionId).toBe(seen); executions++; return { status: 'submitted', secret: 'not forwarded' } },
  }
  const execute = createHostedComputerExecutor({ authority, liveComputer: () => { if (!active) throw new Error('stopped'); return { botId: 'bot', ownerId: 'owner', policyVersion: 3 } }, executeOrdinary: async () => { throw new Error('wrong path') } })
  const b = new ComputerBroker({ driver, socketPath: join(tempDir(), 'sock'), permitted: () => active, execute })
  try {
    const grant = b.spec('run', permission, { display: ':2' })!
    const result = b.request(grant.token, { name: 'click', arguments: { x: 1, y: 2 } })
    if (permission === 'ask') { const review = b.list()[0]; expect(executions).toBe(0); await b.decide(review.id, review.digest, true); expect(seen).toBe(review.id) }
    expect(await result).toEqual({ status: 'submitted' })
    expect(executions).toBe(1)
    active = false
    await expect(b.request(grant.token, { name: 'click', arguments: { x: 1, y: 2 } })).rejects.toThrow()
    expect(executions).toBe(1)
  } finally { console.log('Retained credential broker test resources') }
})

it('rejects a substituted action id before reaching the credential service', async () => {
  const call = { name: 'click', arguments: { x: 1, y: 2 } }
  const driver = { installed: true as const, version: 'fixture', path: '/fixture', fingerprint: 'f'.repeat(64) }
  let invoked = false
  const intent: CredentialIntent = { actionId: 'other', runId: 'run', userId: 'owner', workspaceId: 'workspace', botId: 'bot', subagentId: 'sub', epoch: 1, display: ':2', policyVersion: 3, driverFingerprint: driver.fingerprint, callDigest: createHash('sha256').update(JSON.stringify(call)).digest('hex'), expiresAt: Date.now() + 10000, targetId: 'target', origin: 'https://example.test', loaderId: 'loader', backendNodeId: 7, role: 'password' }
  const execute = createHostedComputerExecutor({ liveComputer: () => ({ botId: 'bot', ownerId: 'owner', policyVersion: 3 }), executeOrdinary: async () => null, authority: { consumeMatchingIntent: async () => ({ kind: 'credential', intent }), withCurrentLease: async (_intent, action) => action({ ...intent, running: true }), executeCredential: async () => { invoked = true; return { status: 'submitted' } } } })
  const b = new ComputerBroker({ driver, socketPath: join(tempDir(), 'sock'), permitted: () => true, execute })
  try { const grant = b.spec('run', 'allow', { display: ':2' })!; await expect(b.request(grant.token, call)).rejects.toThrow('Credential action unavailable'); expect(invoked).toBe(false) } finally { console.log('Retained credential broker test resources') }
})

it.each(['stop', 'target', 'policy'] as const)('rechecks %s after the authority fence is acquired', async mode => {
  const driver = { installed: true as const, version: 'fixture', path: '/fixture', fingerprint: 'f'.repeat(64) }
  let active = true, executed = false
  const authority: CredentialExecutorAuthority = {
    async consumeMatchingIntent(runId, actionId, digest) {
      return { kind: 'credential', intent: { actionId, runId, userId: 'owner', workspaceId: 'workspace', botId: 'bot', subagentId: 'sub', epoch: 1, display: ':2', policyVersion: 3, driverFingerprint: driver.fingerprint, callDigest: digest, expiresAt: Date.now() + 10000, targetId: 'target', origin: 'https://example.test', loaderId: 'loader', backendNodeId: 7, role: 'password' } }
    },
    async withCurrentLease(intent, action) {
      if (mode === 'stop') active = false
      return action({ ...intent, running: true, targetId: mode === 'target' ? 'other' : intent.targetId, policyVersion: mode === 'policy' ? 4 : intent.policyVersion })
    },
    async executeCredential() { executed = true; return { status: 'submitted' } },
  }
  const execute = createHostedComputerExecutor({ authority, liveComputer: () => { if (!active) throw new Error('stopped'); return { botId: 'bot', ownerId: 'owner', policyVersion: 3 } }, executeOrdinary: async () => null })
  const b = new ComputerBroker({ driver, socketPath: join(tempDir(), 'sock'), permitted: () => active, execute })
  try { const grant = b.spec('run', 'allow', { display: ':2' })!; await expect(b.request(grant.token, { name: 'click', arguments: { x: 1, y: 2 } })).rejects.toThrow(); expect(executed).toBe(false) } finally { console.log('Retained credential broker test resources') }
})
