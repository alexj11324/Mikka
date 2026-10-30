import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const head = 'a'.repeat(40), fingerprint = 'b'.repeat(64)
const c = { originRunId: 'origin', originSessionId: 'session', issueId: 'issue', remoteKey: 'v2/github.com/owner/repo', prNumber: 12, scopeVersion: 1, head, fingerprint, followUp: 'CI finished.', requireSessionResume: true as const }
let observation: Record<string, unknown> | null = { generation: '4', head, fingerprint, originRunId: 'origin' }
let retired = 0
const pool = {
  query: async () => ({ rows: observation ? [observation] : [] }),
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
const modulePromise = import('./ci-continuation')

test('claim preflight reads only the watch row: current head, result and origin are valid; anything else is stale', async () => {
  const { preflightCiClaim } = await modulePromise
  observation = { generation: '4', head, fingerprint, originRunId: 'origin', active: true }
  assert.deepEqual(await preflightCiClaim('user', c), { kind: 'valid', generation: '4' })
  for (const changed of [{ head: 'c'.repeat(40) }, { fingerprint: null }, { fingerprint: 'd'.repeat(64) }, { originRunId: 'other' }, { active: false }]) {
    observation = { generation: '5', head, fingerprint, originRunId: 'origin', active: true, ...changed }
    assert.deepEqual(await preflightCiClaim('user', c), { kind: 'stale', generation: '5' })
  }
  observation = null
  assert.deepEqual(await preflightCiClaim('user', c), { kind: 'stale', generation: null })
  observation = { generation: '4', head, fingerprint, originRunId: 'origin', active: true }
  assert.deepEqual(await preflightCiClaim('user', { ...c, requireSessionResume: false as never }), { kind: 'stale', generation: '4' })
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
