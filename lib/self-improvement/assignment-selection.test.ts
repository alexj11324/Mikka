import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { assignedSkillForRun, createSkillAssignments } from './assignments'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN } from './builtin-skill'
import { SKILL_PATH } from './regression'
import { skillMarkdown } from '@mikka/protocol/skill'

function fixture() {
  const userId = 'owner', versionId = randomUUID()
  const run = { id: randomUUID(), issueId: randomUUID(), agentId: randomUUID(), deviceRepoId: randomUUID(), deviceId: randomUUID(),
    userId, status: 'queued', startedAt: null as Date | null, leaseExpiresAt: null as Date | null, stopRequestedAt: null }
  const markdown = '---\nname: Run report\n---\n\nCandidate instructions from exact committed bytes.\n'
  const artifact = { ...BASELINE_ARTIFACT, versionId, sha256: createHash('sha256').update(markdown).digest('hex') }
  const metadata = { versionId, userId, issueId: run.issueId, agentId: run.agentId, repoId: run.deviceRepoId,
    baselineVersionId: BASELINE_ARTIFACT.versionId, path: SKILL_PATH }
  const state = { selection: null as Record<string, unknown> | null, purpose: null as Record<string, unknown> | null,
    receipt: null as Record<string, unknown> | null, withdrawn: false, evaluationAllowed: true, authorized: true }
  const locks: string[] = []
  const tx = { release() {}, query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes('FROM issues')) locks.push('issue')
    if (sql.includes('pg_advisory')) locks.push('scope')
    if (sql.includes('FROM agent_runs') && sql.includes('FOR SHARE')) locks.push('run')
    if (sql.startsWith('INSERT INTO improvement_skill_selections')) {
      state.selection ??= Object.fromEntries(['runId','userId','issueId','agentId','repoId','deviceId','versionId'].map((key,index) => [key,values[index]]))
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO improvement_skill_run_purposes')) {
      state.purpose ??= Object.fromEntries(['runId','userId','versionId','purpose','evaluationId'].map((key,index) => [key,values[index]]))
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO improvement_skill_receipts')) {
      state.receipt ??= { id: values[0], userId: values[2], receipt: JSON.parse(values[3] as string) }
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO improvement_skill_versions')) return { rows: [] }
    if (sql.includes('UPDATE agent_runs')) { run.leaseExpiresAt = new Date(values[3] as string); return { rows: [{ id: run.id }], rowCount: 1 } }
    if (sql.includes('FROM improvement_skill_versions')) return { rows: [values[0] === BASELINE_ARTIFACT.versionId ?
      { artifact: BASELINE_ARTIFACT, markdown: BASELINE_MARKDOWN } : { artifact, markdown }] }
    if (sql.includes('FROM improvement_skill_candidates')) return { rows: [metadata] }
    if (sql.includes("operation='withdraw'")) return { rows: state.withdrawn ? [{ id: randomUUID() }] : [] }
    if (sql.includes('FROM improvement_skill_lifecycle')) return { rows: [{ operation: 'activate', versionId }] }
    if (sql.includes('FROM improvement_skill_run_purposes')) return { rows: state.purpose ? [state.purpose] : [] }
    if (sql.includes('FROM improvement_skill_receipts s')) return { rows: state.receipt ? [{ ...state.receipt, artifact, markdown }] : [] }
    if (sql.includes('FROM improvement_skill_receipts')) return { rows: state.receipt ? [state.receipt] : [] }
    if (sql.includes('LEFT JOIN improvement_skill_receipts')) return { rows: state.selection ? [{ runId: run.id, id: state.receipt?.id }] : [] }
    if (sql.includes('FROM improvement_skill_selections')) return { rows: state.selection ? [state.selection] : [] }
    if (sql.includes('FROM agent_runs')) return { rows: [run] }
    return { rows: [] }
  } } as unknown as PoolClient
  const pool = { connect: async () => tx, query: tx.query.bind(tx) } as unknown as Pool
  const authorize = async () => state.authorized
  const assignments = createSkillAssignments(pool, authorize, async () => state.evaluationAllowed)
  const claim = async () => {
    run.status = 'preparing'; run.startedAt = new Date(Date.now() - 1000); run.leaseExpiresAt = new Date(Date.now() + 60000)
    return assignments.recordClaim(userId, run.deviceId, run.id, run.leaseExpiresAt.toISOString(), true)
  }
  return { userId, versionId, run, artifact, markdown, metadata, state, locks, tx, pool, authorize, assignments, claim }
}

test('active assignment mounts exact candidate bytes and withdrawals block claim, resume and heartbeat while retaining history', async () => {
  const f = fixture()
  await f.assignments.selectActive(f.userId, f.run.id)
  assert.deepEqual(f.locks.slice(0,3), ['issue','scope','run'])
  await assert.rejects(f.assignments.preflight(f.userId, f.run.id, false), /workerCapabilityRequired/)
  const prepared = await f.claim()
  assert.ok(prepared.skillReceipt && prepared.skills)
  assert.deepEqual(prepared.skillReceipt.artifact, f.artifact)
  assert.equal(skillMarkdown(prepared.skills[0]), f.markdown)
  const again = await f.assignments.recordClaim(f.userId, f.run.deviceId, f.run.id, f.run.leaseExpiresAt!.toISOString(), true)
  assert.equal(again.skillReceipt?.id, prepared.skillReceipt.id)
  await f.assignments.revalidate(f.userId, f.run.id, prepared.skillReceipt.id, true)
  assert.ok((await f.assignments.renewHeartbeat(f.userId, f.run.deviceId, [f.run.id], true)).leases[f.run.id])
  f.state.withdrawn = true
  await assert.rejects(f.assignments.preflight(f.userId, f.run.id, true), /runUnavailable/)
  await assert.rejects(f.assignments.recordClaim(f.userId, f.run.deviceId, f.run.id, f.run.leaseExpiresAt!.toISOString(), true), /runUnavailable/)
  await assert.rejects(f.assignments.revalidate(f.userId, f.run.id, prepared.skillReceipt.id, true), /runUnavailable/)
  assert.deepEqual((await f.assignments.renewHeartbeat(f.userId, f.run.deviceId, [f.run.id], true)).revoked, [f.run.id])
  assert.equal((await assignedSkillForRun(f.tx, f.userId, f.run)).skillUsage, 'assigned')
})

test('candidate scope and evaluation verifier remain enforced before selection and on resumed work', async () => {
  const f = fixture(), evaluationId = randomUUID()
  const closed = createSkillAssignments(f.pool, f.authorize)
  await assert.rejects(closed.selectVersion(f.userId, f.run.id, f.versionId, { purpose: 'evaluation', evaluationId }, f.tx), /sourceRequired/)
  assert.equal(f.state.selection, null)
  await f.assignments.selectVersion(f.userId, f.run.id, f.versionId, { purpose: 'evaluation', evaluationId }, f.tx)
  const prepared = await f.claim(); assert.ok(prepared.skillReceipt)
  f.state.evaluationAllowed = false
  await assert.rejects(f.assignments.revalidate(f.userId, f.run.id, prepared.skillReceipt.id, true), /sourceRequired/)
  f.state.evaluationAllowed = true
  f.metadata.agentId = randomUUID()
  await assert.rejects(f.assignments.preflight(f.userId, f.run.id, true), /sourceMismatch/)
})

test('heartbeat excludes malformed IDs from the UUID lookup and preserves them for legacy revocation', async () => {
  const runId = randomUUID(), runIds = [runId, 'not-a-uuid']
  const pool = { query: async (_sql: string, values: unknown[]) => {
    assert.deepEqual(values[1], [runId])
    return { rows: [] }
  } } as unknown as Pool
  const assignments = createSkillAssignments(pool, async () => false)
  assert.deepEqual(await assignments.renewHeartbeat('owner', 'device', runIds, false),
    { legacy: runIds, leases: {}, revoked: [] })
})
