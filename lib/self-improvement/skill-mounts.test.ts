import assert from 'node:assert/strict'
import { emptyRunReport } from '@mikka/protocol/run'
import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { assertSkillMountBinding, recordCompletionSkillMount } from './skill-mounts'
import { BASELINE_ARTIFACT } from './builtin-skill'

function fixture() {
  const now = new Date(), startedAt = new Date(now.getTime() - 5000), assignedAt = new Date(now.getTime() - 4000)
  const run = { id: randomUUID(), userId: 'owner', issueId: randomUUID(), agentId: randomUUID(), deviceRepoId: randomUUID(),
    deviceId: randomUUID(), sessionId: 'real-session', status: 'running', stopRequestedAt: null, startedAt,
    leaseExpiresAt: new Date(now.getTime() + 60000) }
  const receipt = { id: randomUUID(), runId: run.id, issueId: run.issueId, agentId: run.agentId, repoId: run.deviceRepoId,
    deviceId: run.deviceId, assignedAt: assignedAt.toISOString(), leaseExpiresAt: run.leaseExpiresAt.toISOString(), artifact: BASELINE_ARTIFACT }
  const mount = { receiptId: receipt.id, versionId: receipt.artifact.versionId, sha256: receipt.artifact.sha256,
    sessionId: run.sessionId, mountedAt: new Date(now.getTime() - 1000).toISOString() }
  return { run, receipt, mount, now }
}

test('completion accepts only the immutable receipt, exact bytes and actual live session', () => {
  const { run, receipt, mount, now } = fixture()
  assert.deepEqual(assertSkillMountBinding(run, 'owner', mount, receipt, now), mount)
  for (const changed of [{ receiptId: randomUUID() }, { versionId: randomUUID() }, { sha256: 'f'.repeat(64) },
    { sessionId: 'model-lie' }, { mountedAt: new Date(now.getTime() + 1).toISOString() },
    { mountedAt: new Date(run.startedAt.getTime() - 1).toISOString() }])
    assert.throws(() => assertSkillMountBinding(run, 'owner', { ...mount, ...changed }, receipt, now), /sourceMismatch/)
  for (const changed of [{ runId: randomUUID() }, { issueId: randomUUID() }, { agentId: randomUUID() },
    { repoId: randomUUID() }, { deviceId: randomUUID() }])
    assert.throws(() => assertSkillMountBinding(run, 'owner', mount, { ...receipt, ...changed }, now), /sourceMismatch/)
})
test('stale, stopped, wrong-owner and unstarted completions cannot mint mount evidence', () => {
  const { run, receipt, mount, now } = fixture()
  for (const changed of [{ userId: 'other' }, { sessionId: null }, { startedAt: null }, { status: 'succeeded' },
    { stopRequestedAt: now }, { leaseExpiresAt: now }, { leaseExpiresAt: null }])
    assert.throws(() => assertSkillMountBinding({ ...run, ...changed }, 'owner', mount, receipt, now), /sourceMismatch/)
})

test('cancelled and device-lost completions settle without consulting revoked sources or minting a mount', async () => {
  const { mount } = fixture()
  const tx = { query: () => { throw new Error('Must not create mount evidence') } } as unknown as PoolClient
  for (const reason of ['cancelled', 'device_lost'] as const) {
    const report = { ...emptyRunReport(), skillMount: mount }
    const settled = await recordCompletionSkillMount(tx, 'owner', randomUUID(), reason, report, async () => false)
    assert.equal(settled?.skillMount, undefined)
    assert.deepEqual(report.skillMount, mount)
  }
})
