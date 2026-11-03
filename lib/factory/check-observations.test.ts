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
    if (sql.includes('FROM run_chunks i JOIN run_chunks o')) {
      assert.deepEqual(args, ['producer', 'native-session', 'owner', 'issue', 'candidate', 'task', sha])
      return { rows: [{ inputChunkId: 'input-id', outputChunkId: 'output-id', seq: 1, toolName: 'bash', inputJson: JSON.stringify({ command: 'git diff --check && git status --short' }), outputType: 'tool-output-available', outputJson: JSON.stringify({ exitCode: 0, output: ' M DELIVERY.txt' }), inputTruncated: false, outputTruncated: false }] }
    }
    if (sql.includes("UPDATE agent_runs SET kind='acceptance'")) prompt = args[2] as string
    return { rows: [], rowCount: 1 }
  } } as unknown as PoolClient
  await configureFactoryCheck(tx, { stage: 'verify', status: 'pending', candidateId: 'candidate', id: 'task', userId: 'owner', issueId: 'issue', attemptId: 'attempt' } as FactoryTask, 'check-run')
  assert.match(prompt, /Persisted producer command observations/)
  assert.match(prompt, /git diff --check/)
  assert.match(prompt, /input-id/)
  assert.match(prompt, /not the producer report/)
  assert.match(prompt, /may precede the host-retained deliverable commit/)
  assert.match(prompt, /mikka\.inspect_artifact/)
  assert.match(prompt, /independent observations from the granted artifact or computer tools/)
  assert.doesNotMatch(prompt, /using real commands and observations/)
  assert.match(prompt, /If a criterion explicitly requires independent command execution, report the missing capability/)
  assert.match(prompt, /contentUtf8/)
  assert.match(prompt, /expectedUtf8/)
  assert.match(prompt, /Do not pass a criterion from the producer report alone/)
  assert.doesNotMatch(prompt, /Use the granted mikka\.verify_command tool/)
  assert.match(prompt, /"runId":"producer".*"sessionId":"native-session".*"model":"deepseek-flash".*"harness":"claude_code"/)
  assert.match(prompt, /not a provider billing log or proof of an alias version/)
  assert.match(prompt, /Missing observations are not observed mismatches/)
  assert.doesNotMatch(prompt, /private-key-must-not-appear/)
})
