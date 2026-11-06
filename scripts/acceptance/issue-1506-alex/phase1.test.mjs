import assert from 'node:assert/strict'
import test from 'node:test'
import { runPhase, validateInvocation } from './phase1.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }
const config = { schemaVersion: 1, phase: 'setup-and-1490-baseline', expectedSha: 'a'.repeat(40), fixtureRunKey: 'acme-1506-fixture' }
const version = build => async () => Response.json({ build })

test('phase control rejects extra fields and cannot run a driver on the wrong build', async () => {
  assert.throws(() => validateInvocation({ ...config, allowAnyVersion: true }), /phase_invocation_invalid/)
  let calls = 0
  const report = await runPhase('workspace', { invocation: config, checkpoint: false, fetchImpl: version('b'.repeat(40)),
    drivers: { workspace: async () => { calls++; return { status: 'ready' } } } })
  assert.equal(calls, 0); assert.equal(report.attempted, false); assert.equal(report.status, 'failed')
  assert.equal(report.before.matches, false); assert.equal(report.after.matches, false)
})

test('a failed baseline retains failed status and records its actual post-build without retry', async () => {
  let calls = 0, reads = 0
  const report = await runPhase('baseline-luna', { invocation: config, checkpoint: false,
    fetchImpl: async () => { reads++; return Response.json({ build: config.expectedSha }) },
    drivers: { baseline: async ({ env }) => { calls++; assert.equal(env.MIKKA_FIXTURE_KIND, 'luna'); return { status: 'failed', error: 'stream_error' } } } })
  assert.equal(calls, 1); assert.equal(reads, 2); assert.equal(report.status, 'failed')
  assert.equal(report.observationStatus, 'failed'); assert.equal(report.applicationVersionStable, true)
})

test('a deployment crossing a successful phase invalidates only the acceptance result', async () => {
  let reads = 0
  const report = await runPhase('fixtures', { invocation: config, checkpoint: false,
    fetchImpl: async () => Response.json({ build: ++reads === 1 ? config.expectedSha : 'b'.repeat(40) }),
    drivers: { fixtures: async () => ({ status: 'ready' }) } })
  assert.equal(report.attempted, true); assert.equal(report.observationStatus, 'ready')
  assert.equal(report.status, 'failed'); assert.equal(report.applicationVersionStable, false)
})
