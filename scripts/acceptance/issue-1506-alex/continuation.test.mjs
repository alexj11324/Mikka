import assert from 'node:assert/strict'
import test from 'node:test'
import { runContinuation, validateContinuation } from './continuation.mjs'
import { fixtureReceipt, SHA, RUN_KEY, WORKSPACE_ID } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }
const config = { schemaVersion: 1, enabled: true, phase: 'cache-live', expectedSha: SHA,
  fixtureRunKey: RUN_KEY, workspaceId: WORKSPACE_ID, fixtureReceipt: 'receipts/fixture.json', fixtureReceiptSha256: 'a'.repeat(64),
  cacheTurns: 2, liveTabs: 3, delayOneReturnedResult: false, groupBoundary: 'responding_bot' }

test('disabled, unknown-phase, missing-ready and wrong-workspace continuation cannot execute a model driver', async () => {
  await assert.rejects(runContinuation('haiku', { config: { ...config, enabled: false }, receipt: fixtureReceipt(), checkpoint: false }), /continuation_disabled/)
  assert.throws(() => validateContinuation({ ...config, phase: 'setup' }, fixtureReceipt()), /continuation_invalid/)
  const notReady = fixtureReceipt(); notReady.fixtures[0].status = 'failed'
  assert.throws(() => validateContinuation(config, notReady), /fixture_receipt_invalid/)
  assert.throws(() => validateContinuation({ ...config, workspaceId: 'wrong' }, fixtureReceipt()), /continuation_scope_invalid/)
})

test('continuation passes only the retained ready fixture and preserves a failed observation between pinned version reads', async () => {
  let calls = 0, reads = 0
  const receipt = fixtureReceipt()
  const report = await runContinuation('luna', { config, receipt, checkpoint: false,
    fetchImpl: async () => { reads++; return Response.json({ build: SHA }) },
    driver: async options => { calls++; assert.equal(options.fixtureReceipt, receipt); assert.equal(options.env.MIKKA_FIXTURE_KIND, 'luna');
      assert.equal(options.env.MIKKA_CACHE_TURNS, '2'); return { status: 'failed', error: 'stream_deadline' } } })
  assert.equal(calls, 1); assert.equal(reads, 2); assert.equal(report.status, 'failed')
  assert.equal(report.setupWrites, 0); assert.equal(report.modelSelectionWrites, 0); assert.equal(report.shareWrites, 0)
  assert.equal(report.observation.error, 'stream_deadline')
})


test('private continuation requires the private generation receipt boundary and cannot masquerade as public responding', () => {
  assert.throws(() => validateContinuation({ ...config, phase: 'group-private' }, fixtureReceipt()), /continuation_invalid/)
  assert.throws(() => validateContinuation({ ...config, phase: 'group-public', groupBoundary: 'private_generation_receipt' }, fixtureReceipt()), /continuation_invalid/)
  assert.equal(validateContinuation({ ...config, phase: 'group-private', groupBoundary: 'private_generation_receipt' }, fixtureReceipt()).phase, 'group-private')
})

test('private continuation reuses ready models and forwards an explicit scenario between two real version observations', async () => {
  const receipt = fixtureReceipt()
  let calls = 0, versions = 0
  const report = await runContinuation('haiku', { config: { ...config, phase: 'group-private', groupBoundary: 'private_generation_receipt' },
    receipt, checkpoint: false, fetchImpl: async () => { versions++; return Response.json({ build: SHA }) },
    driver: async options => { calls++; assert.equal(options.fixtureReceipt, receipt); assert.equal(options.env.MIKKA_FIXTURE_KIND, 'haiku');
      assert.equal(options.env.MIKKA_GROUP_STOP_SCENARIO, 'private'); assert.equal(options.env.MIKKA_GROUP_STOP_BOUNDARY, 'private_generation_receipt');
      return { status: 'stop_evidence_captured', runtimeCancellation: 'pending_provider_logs', cleanup: { retainedForProviderAudit: true } } } })
  assert.equal(report.status, 'observed'); assert.equal(calls, 1); assert.equal(versions, 2)
  assert.equal(report.observation.runtimeCancellation, 'pending_provider_logs'); assert.equal(report.observation.cleanup.retainedForProviderAudit, true)
  assert.equal(report.setupWrites, 0); assert.equal(report.modelSelectionWrites, 0); assert.equal(report.shareWrites, 0)
})
