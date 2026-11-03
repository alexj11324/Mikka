import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { configureFactoryCheck } from './checks'
import type { FactoryTask } from './store'

test('independent delivery prompt carries host execution observations and usable file evidence, without producer credentials', async () => {
  const sha = 'a'.repeat(40)
  let prompt = ''
  const tx = { query: async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT c.*')) return { rows: [{ id: 'candidate', kind: 'deliverable', executionSha: sha,
      deviceId: 'device', deviceRepoId: 'repo', environment: 'device:device', repository: '/delivery', repoPath: '/delivery',
      remoteUrl: null, enabled: true, deviceKind: 'cloud', cloudOnline: true, harness: 'claude_code',
      harnesses: [{ harness: 'claude_code', installed: true }],
      producerExecution: { runId: 'producer', sessionId: 'native-session', status: 'succeeded', model: 'deepseek-flash', harness: 'claude_code', observedModel: null },
      producerDefinition: { apiKey: 'private-key-must-not-appear' }, producerReport: { summary: 'Produced the file.' },
    }] }
    if (sql.includes("UPDATE agent_runs SET kind='acceptance'")) prompt = args[2] as string
    return { rows: [], rowCount: 1 }
  } } as unknown as PoolClient
  await configureFactoryCheck(tx, { stage: 'verify', status: 'pending', candidateId: 'candidate', id: 'task', userId: 'owner', issueId: 'issue', attemptId: 'attempt' } as FactoryTask, 'check-run')
  assert.match(prompt, /mikka\.inspect_artifact/)
  assert.match(prompt, /"runId":"producer".*"sessionId":"native-session".*"model":"deepseek-flash".*"harness":"claude_code"/)
  assert.match(prompt, /not a provider billing log or proof of an alias version/)
  assert.match(prompt, /Missing observations are not observed mismatches/)
  assert.doesNotMatch(prompt, /private-key-must-not-appear/)
})
