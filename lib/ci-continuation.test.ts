import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const head = 'a'.repeat(40), fingerprint = 'b'.repeat(64)
const c = { originRunId: 'origin', originSessionId: 'session', issueId: 'issue', remoteKey: 'v2/github.com/owner/repo', prNumber: 12, scopeVersion: 1, head, fingerprint, followUp: 'CI finished.', requireSessionResume: true as const }
let observation: Record<string, unknown> | null = { generation: '4', head, fingerprint, originRunId: 'origin' }
let provider: 'matching' | 'changed' | 'offline' = 'matching'
let retired = 0
const pool = {
  query: async () => ({ rows: [{ installationId: 1, repositoryId: 2, branch: 'mikka/issue-1', ...(observation ?? { generation: null }) }] }),
  connect: async () => ({
    query: async (sql: string) => {
      if (sql.startsWith('SELECT generation')) return { rows: observation ? [observation] : [] }
      if (sql.startsWith('UPDATE agent_runs')) { retired++; return { rowCount: 1, rows: [{ id: 'child' }] } }
      return { rows: [] }
    }, release: () => {},
  }),
}
mock.module('@/lib/db', { namedExports: { pool } })
mock.module('@/lib/agent-runs', { namedExports: { queueFactoryRun: async () => ({ runId: 'child', status: 'queued', replayed: false }) } })
mock.module('@/lib/github/repository-installation', { namedExports: { linkedGitHubAccountId: async () => '3' } })
mock.module('@/lib/github/run-pull-request', { namedExports: { verifyGitHubRepositoryAccess: async () => ({ installationId: 1, repositoryId: 2 }) } })
mock.module('@/lib/github/ci/read', { namedExports: { readCi: async () => { if (provider === 'offline') throw Error('offline'); return { open: true, head: provider === 'matching' ? head : 'c'.repeat(40), snapshot: {} } } } })
mock.module('@/lib/github/ci/attempts', { namedExports: { listCiWorkflowAttempts: async () => [] } })
mock.module('@/lib/github/ci/snapshot', { namedExports: { summarize: () => ({ kind: 'complete', fingerprint, outcome: 'success', failed: [] }) } })
const modulePromise = import('./ci-continuation')

test('live read, revoked observation and unavailable provider fail closed', async () => {
  const { preflightCiClaim } = await modulePromise
  provider = 'matching'; observation = { generation: '4', head, fingerprint, originRunId: 'origin' }
  assert.deepEqual(await preflightCiClaim('user', c), { kind: 'valid', generation: '4' })
  observation = null
  assert.deepEqual(await preflightCiClaim('user', c), { kind: 'stale', generation: null })
  provider = 'offline'
  assert.deepEqual(await preflightCiClaim('user', c), { kind: 'unavailable' })
  provider = 'changed'
  assert.deepEqual(await preflightCiClaim('user', c), { kind: 'stale', generation: null })
})

test('stale retirement checks observation generation before stopping the queued run', async () => {
  const { retireStaleCiRun } = await modulePromise
  retired = 0; observation = { generation: '5', head, fingerprint, originRunId: 'origin' }
  assert.equal(await retireStaleCiRun('user', 'child', c, '4'), false)
  assert.equal(retired, 0)
  assert.equal(await retireStaleCiRun('user', 'child', c, '5'), true)
  assert.equal(retired, 1)
})

test('claim guard requires original session, original device and matching generation', async () => {
  const { guardCiClaim } = await modulePromise
  let generation = '4'
  const row = { ciContinuation: c, status: 'queued', stopRequestedAt: null, originStop: null, deviceId: 'device', originDeviceId: 'device', agentId: 'agent', originAgentId: 'agent', deviceRepoId: 'repo', originRepoId: 'repo', botId: null, originBotId: null, sessionId: 'session', agentDefinition: { definitionDigest: 'digest' }, originDefinition: { definitionDigest: 'digest' } }
  const tx = { query: async (_sql: string, values: unknown[]) => ({ rows: values[9] === generation ? [row] : [] }) }
  const claim = await guardCiClaim(tx as never, 'user', 'device', 'child', c, '4')
  assert.equal(claim?.resumeSessionId, 'session')
  assert.equal(claim?.requireSessionResume, true)
  generation = '5'
  assert.equal(await guardCiClaim(tx as never, 'user', 'device', 'child', c, '4'), null)
  generation = '4'; row.sessionId = 'different'
  assert.equal(await guardCiClaim(tx as never, 'user', 'device', 'child', c, '4'), null)
})
