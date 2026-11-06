import assert from 'node:assert/strict'
import test from 'node:test'
import { validateResumeInvocation, runResumePhase } from './resume-baseline.mjs'
import { fixtureReceipt, workspaceReceipt, SHA, RUN_KEY, WORKSPACE_ID } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }
const invocation = { schemaVersion: 1, phase: 'resume-and-1490-baseline', expectedSha: SHA, fixtureRunKey: RUN_KEY,
  workspaceId: WORKSPACE_ID, workspaceReceipt: 'receipts/workspace.json', fixtureReceipt: 'receipts/fixtures.json',
  workspaceReceiptSha256: 'a'.repeat(64), fixtureReceiptSha256: 'b'.repeat(64) }

test('resume refuses incomplete, different-workspace or path-traversal receipts before any execution', () => {
  const pending = fixtureReceipt(); pending.fixtures[0].selectionAttempted = false
  assert.throws(() => validateResumeInvocation(invocation, workspaceReceipt(), pending), /resume_receipt_invalid/)
  assert.throws(() => validateResumeInvocation({ ...invocation, workspaceId: '77777777-7777-4777-8777-777777777777' }, workspaceReceipt(), fixtureReceipt()), /resume_receipt_invalid/)
  assert.throws(() => validateResumeInvocation({ ...invocation, fixtureReceipt: '../other.json' }, workspaceReceipt(), fixtureReceipt()), /resume_invocation_invalid/)
})

test('resume calls only existing-fixture resume and pins both public version observations', async () => {
  let calls = 0, reads = 0
  const receipt = fixtureReceipt()
  const report = await runResumePhase('fixtures', { invocation, fixtureReceipt: receipt, workspaceReceipt: workspaceReceipt(), checkpoint: false,
    fetchImpl: async () => { reads++; return Response.json({ build: SHA }) },
    drivers: { fixtures: async options => { calls++; assert.equal(options.mode, 'resume'); assert.equal(options.receipt, receipt); return { status: 'ready' } } } })
  assert.equal(calls, 1); assert.equal(reads, 2); assert.equal(report.status, 'observed')
})
