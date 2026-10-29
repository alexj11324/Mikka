import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Pool, PoolClient } from 'pg'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN, BASELINE_SKILL } from './builtin-skill'
import { canonicalSkill, currentSkillEligibility, createSkillRegistry, resolveSkillVersion } from './registry'
import { SKILL_PATH } from './regression'

test('canonical single Skill preserves baseline identity and rejects noncanonical or extra frontmatter', () => {
  assert.deepEqual(canonicalSkill(BASELINE_MARKDOWN), BASELINE_SKILL)
  for (const markdown of [BASELINE_MARKDOWN.replace('name: Run report', 'name: Another'),
    BASELINE_MARKDOWN.replace('name: Run report', 'name: Run report\ndescription: extra'),
    BASELINE_MARKDOWN.replace(/\n/g, '\r\n'), BASELINE_MARKDOWN.trimEnd(),
    `${BASELINE_MARKDOWN}\n`, BASELINE_MARKDOWN.replace('\n\n', '\n\n '),
    '---\nname: Run report\n---\n\n\n', '---\nname: Run report\n---\n\n' + '🧪'.repeat(6000) + '\n',
    '---\nname: Run report\n---\n\n\ud800\n']) assert.throws(() => canonicalSkill(markdown), /sourceMismatch/)
})

test('version resolution checks raw digest and candidate scope while retaining historical content', async () => {
  const run = { issueId: randomUUID(), agentId: randomUUID(), deviceRepoId: randomUUID() }
  const versionId = randomUUID(), userId = 'owner'
  const markdown = '---\nname: Run report\n---\n\nA real candidate body.\n'
  const artifact = { ...BASELINE_ARTIFACT, versionId, sha256: createHash('sha256').update(markdown).digest('hex') }
  const metadata = { versionId, userId, issueId: run.issueId, agentId: run.agentId, repoId: run.deviceRepoId,
    baselineVersionId: BASELINE_ARTIFACT.versionId, path: SKILL_PATH }
  let stored = { artifact, markdown }, candidate: object | null = metadata
  const tx = { query: async (sql: string) => ({ rows: sql.includes('improvement_skill_versions') ? [stored] : candidate ? [candidate] : [] }) } as unknown as PoolClient
  assert.equal((await resolveSkillVersion(tx, userId, run, versionId)).markdown, markdown)
  for (const changed of [{ ...run, issueId: randomUUID() }, { ...run, agentId: randomUUID() }, { ...run, deviceRepoId: randomUUID() }])
    await assert.rejects(resolveSkillVersion(tx, userId, changed, versionId), /sourceMismatch/)
  stored = { artifact, markdown: markdown + 'tampered' }
  await assert.rejects(resolveSkillVersion(tx, userId, run, versionId), /sourceMismatch/)
  stored = { artifact: { ...artifact, sha256: BASELINE_ARTIFACT.sha256 }, markdown }
  await assert.rejects(resolveSkillVersion(tx, userId, run, versionId), /sourceMismatch/)
  stored = { artifact, markdown }; candidate = null
  await assert.rejects(resolveSkillVersion(tx, userId, run, versionId), /sourceMismatch/)
})


test('current candidate use requires trusted purpose and activation; withdrawal preserves history but blocks use', async () => {
  const run = { id: randomUUID(), issueId: randomUUID(), agentId: randomUUID(), deviceRepoId: randomUUID() }
  const userId = 'owner', versionId = randomUUID(), markdown = BASELINE_MARKDOWN
  const artifact = { ...BASELINE_ARTIFACT, versionId }
  const metadata = { versionId, userId, issueId: run.issueId, agentId: run.agentId,
    repoId: run.deviceRepoId, baselineVersionId: BASELINE_ARTIFACT.versionId, path: SKILL_PATH }
  let purpose: object | null = null, withdrawn = false, latest: object | null = null
  const tx = { query: async (sql: string) => {
    if (sql.includes('improvement_skill_versions')) return { rows: [{ artifact, markdown }] }
    if (sql.includes('improvement_skill_candidates')) return { rows: [metadata] }
    if (sql.includes('improvement_skill_run_purposes')) return { rows: purpose ? [purpose] : [] }
    if (sql.includes("operation='withdraw'")) return { rows: withdrawn ? [{ id: randomUUID() }] : [] }
    if (sql.includes('improvement_skill_lifecycle')) return { rows: latest ? [latest] : [] }
    return { rows: [] }
  } } as unknown as PoolClient
  await assert.rejects(currentSkillEligibility(tx, userId, run, artifact), /sourceRequired/)
  purpose = { purpose: 'active', evaluationId: null }
  await assert.rejects(currentSkillEligibility(tx, userId, run, artifact), /runUnavailable/)
  latest = { operation: 'activate', versionId }
  await currentSkillEligibility(tx, userId, run, artifact)
  purpose = { purpose: 'evaluation', evaluationId: randomUUID() }
  await assert.rejects(currentSkillEligibility(tx, userId, run, artifact), /sourceRequired/)
  await currentSkillEligibility(tx, userId, run, artifact, async () => true)
  withdrawn = true
  await assert.rejects(currentSkillEligibility(tx, userId, run, artifact, async () => true), /runUnavailable/)
  assert.equal((await resolveSkillVersion(tx, userId, run, versionId)).markdown, markdown)
  await currentSkillEligibility(tx, userId, run, BASELINE_ARTIFACT)
})

test('registration authorizes before network reads and rechecks a revoked Factory binding after fetching', async () => {
  const userId = 'owner', issueId = randomUUID(), taskId = randomUUID(), candidateId = randomUUID(),
    proposalId = randomUUID(), attemptId = randomUUID(), runId = randomUUID(), agentId = randomUUID(), repoId = randomUUID(), deviceId = randomUUID()
  const binding = { taskId, issueId, attemptId, revision: 1, candidateId }
  const task = { id: taskId, userId, issueId, attemptId, candidateId, revision: 1, status: 'pending' }
  const report = { sourceCommit: 'b'.repeat(40), publish: { commit: 'a'.repeat(40), pushed: true }, verify: { status: 'passed' } }
  const repository = 'https://github.com/example/public'
  const run = { id: runId, userId, issueId, agentId, deviceRepoId: repoId, deviceId, repository, status: 'succeeded',
    stopReason: 'submitted', sessionId: 'execute-session', startedAt: new Date('2026-10-25T00:00:00Z'),
    finishedAt: new Date('2026-10-25T00:01:00Z'), stopRequestedAt: null, report }
  const sourceId = randomUUID(), receiptId = randomUUID()
  const receipt = { id: receiptId, runId: sourceId, issueId, agentId, repoId, deviceId,
    assignedAt: new Date('2026-10-25T00:00:01Z').toISOString(), leaseExpiresAt: new Date('2026-10-25T01:00:00Z').toISOString(), artifact: BASELINE_ARTIFACT }
  const source = { ...run, id: sourceId, scoreId: sourceId, sourceRunId: sourceId, sourceBucket: 'bucket', bucket: 'bucket', scorerDigest: 'scorer',
    outcome: 'failure', snapshot: { runId: sourceId, issueId, agentId, deviceRepoId: repoId, repository,
      sessionId: run.sessionId, reportDigest: '', skillArtifact: BASELINE_ARTIFACT, skillReceipt: receipt } }
  let open = false, authorized = true, fetched = 0, writes = 0
  const { digest } = await import('./contract')
  source.snapshot.reportDigest = digest(source.report)
  const metadata = { versionId: candidateId, userId, issueId, agentId, repoId, proposalId, factoryTaskId: taskId, candidateId,
    repository, commitSha: report.publish.commit, path: SKILL_PATH, baselineVersionId: BASELINE_ARTIFACT.versionId, createdAt: new Date() }
  const tx = { release() {}, query: async (sql: string, values: unknown[] = []) => {
    if (sql === 'BEGIN') { open = true; return { rows: [] } }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { open = false; return { rows: [] } }
    if (sql.startsWith('INSERT')) { writes++; return { rows: [] } }
    if (sql.includes('FROM factory_tasks')) return { rows: [task] }
    if (sql.includes('FROM improvement_proposals')) return { rows: [{ id: proposalId, issueId, scorerDigest: 'scorer', bucket: 'bucket', status: 'awaiting_model_candidate',
      candidate: { kind: 'feedback_candidate_request_v1', path: SKILL_PATH, baseline: BASELINE_MARKDOWN, baselineDigest: BASELINE_ARTIFACT.sha256, baselineArtifact: BASELINE_ARTIFACT, sourceIds: [sourceId] },
      result: { kind: 'not_evaluated', state: 'not_evaluated', productionEligible: false } }] }
    if (sql.includes('FROM improvement_factory_links')) return { rows: [{ taskId, issueId, attemptId, runId, request: { agentId, deviceRepoId: repoId } }] }
    if (sql.includes('FROM factory_candidates')) return { rows: [{ id: candidateId, taskId, runId, repository, sha: report.publish.commit }] }
    if (sql.includes('FROM factory_attempts')) return { rows: [{ id: attemptId, candidateId, runId, stage: 'execute', status: 'passed', sessionId: run.sessionId }] }
    if (sql.includes('FROM improvement_skill_candidates')) return { rows: [metadata] }
    if (sql.includes('FROM improvement_skill_versions')) return { rows: [{ artifact: values[0] === candidateId ?
      { ...BASELINE_ARTIFACT, versionId: candidateId } : BASELINE_ARTIFACT, markdown: BASELINE_MARKDOWN }] }
    if (sql.includes('FROM improvement_skill_receipts')) return { rows: [{ userId, receipt, artifact: BASELINE_ARTIFACT, markdown: BASELINE_MARKDOWN }] }
    if (sql.includes('count(*)')) return { rows: [{ total: 1 }] }
    if (sql.includes('FROM improvement_proposal_sources')) return { rows: [source] }
    if (sql.includes('FROM agent_runs')) return { rows: [run] }
    return { rows: [] }
  } } as unknown as PoolClient
  const pool = { connect: async () => tx } as unknown as Pool
  const registry = createSkillRegistry(pool, async () => authorized)
  const reader = async () => { fetched++; assert.equal(open, false); task.status = 'revoked'; return BASELINE_MARKDOWN }
  const registered = await registry.readRegisteredCandidate(tx, userId, taskId, candidateId)
  assert.equal(registered.metadata.candidateId, candidateId)
  source.status = 'cancelled'
  await assert.rejects(registry.readRegisteredCandidate(tx, userId, taskId, candidateId), /sourceMismatch/)
  source.status = 'succeeded'
  authorized = false
  await assert.rejects(registry.registerCandidate(userId, { proposalId, binding }, reader), /notFound/)
  assert.equal(fetched, 0)
  authorized = true
  await assert.rejects(registry.registerCandidate(userId, { proposalId, binding }, reader), /runUnavailable/)
  assert.equal(fetched, 1); assert.equal(writes, 0); assert.equal(open, false)
})
