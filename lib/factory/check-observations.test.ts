import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { configureFactoryCheck, factoryRepairBrief } from './checks'
import { FactoryError } from './contract'
import type { FactoryTask } from './store'

test('independent delivery prompt carries host execution observations and usable file evidence, without producer credentials', async () => {
  const sha = 'a'.repeat(40)
  let prompt = ''
  const tx = { query: async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT c.*')) return { rows: [{ id: 'candidate', kind: 'deliverable', executionSha: sha,
      deviceId: 'device', deviceRepoId: 'repo', environment: 'device:device', repository: '/delivery', repoPath: '/delivery',
      remoteUrl: null, enabled: true, deviceKind: 'cloud', runtimeBotId: 'bot', runtimeWorkspaceId: 'workspace', agentId: 'agent', harness: 'claude_code',
      harnesses: [{ harness: 'claude_code', installed: true }],
      producerExecution: { runId: 'producer', sessionId: 'native-session', status: 'succeeded', model: 'deepseek-flash', harness: 'claude_code', observedModel: null },
      producerDefinition: { apiKey: 'private-key-must-not-appear' }, producerReport: { summary: 'Produced the file.' },
    }] }
    if (sql.startsWith('SELECT m."deviceId"')) {
      assert.deepEqual(args, ['bot', 'owner', 'workspace', 'agent', 'repo'])
      return { rows: [{ deviceId: 'device', harness: 'claude_code' }] }
    }
    if (sql.startsWith('SELECT c.id,c.kind')) return { rows: [{ id: 'candidate', kind: 'deliverable', reportedSha: sha }] }
    if (sql.includes('FROM run_chunks i JOIN run_chunks o')) {
      assert.deepEqual(args, ['producer', 'native-session', 'owner', 'issue', 'candidate', 'task'])
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
  assert.match(prompt, /mikka\.inspect_repository/)
  assert.match(prompt, /baseCommit/)
  assert.match(prompt, /sourceCommit/)
  assert.match(prompt, /truncated/)
  assert.match(prompt, /Keep each original acceptance criterion distinct/)
  assert.match(prompt, /Host-recorded prior review artifact observations for this same fixed candidate/)
  assert.match(prompt, /does not replace your own new independent artifact and repository inspections/)
  assert.match(prompt, /prior_review_missing/)
  assert.match(prompt, /independent observations from the granted artifact or computer tools/)
  assert.doesNotMatch(prompt, /using real commands and observations/)
  assert.match(prompt, /If a criterion explicitly requires independent command execution, report the missing capability/)
  assert.match(prompt, /contentUtf8/)
  assert.match(prompt, /expectedUtf8/)
  assert.match(prompt, /Do not pass a criterion from the producer report alone/)
  assert.doesNotMatch(prompt, /Use the granted mikka\.verify_command tool/)
  assert.match(prompt, /"runId":"producer".*"sessionId":"native-session".*"model":"deepseek-flash".*"harness":"claude_code"/)
  assert.match(prompt, /not a provider billing log or proof of an alias version/)
  assert.match(prompt, /nativeClaim/)
  assert.match(prompt, /A null observedModel remains unknown/)
  assert.match(prompt, /Missing or conflicting required routing evidence remains unverified/)
  assert.match(prompt, /Missing observations are not observed mismatches/)
  assert.doesNotMatch(prompt, /private-key-must-not-appear/)
})


const originalRepairRequest = 'Only acceptance.txt: exact UTF-8 "mikka-production-20261101-847\\n\\n", 31 bytes. Keep all standing constraints.'
const failedRepairClaim = 'Expected "mikka-production-acceptance-20261101-847\\n\\n", 42 bytes; actual file is 31 bytes.'
function repairBriefFixture(options: { stage?: 'review' | 'verify'; previous?: boolean; context?: boolean; prompt?: string; flowVersion?: 1 | 2 } = {}) {
  const task = { id: 'task', attemptId: 'repair-attempt', userId: 'owner', issueId: 'issue', botId: 'bot', sourceEventId: 'current-request', stage: 'execute', status: 'pending', route: { flowVersion: options.flowVersion ?? 1 } } as FactoryTask
  const pending = { position: 3, output: {} }
  const failed = { id: 'failed-attempt', taskId: task.id, position: 2, stage: options.stage ?? 'review', status: 'failed',
    runId: 'failed-run', sessionId: 'failed-session', candidateId: 'fixed-candidate', reason: failedRepairClaim,
    evidence: [{ artifact: 'run-report:failed-run' }], output: { completion: { trustedFailureProvenance: true,
      findings: [{ passed: false, text: failedRepairClaim, evidence: 'token=synthetic-secret-finding' }] } } }
  const original = options.prompt ?? originalRepairRequest
  let prompt = original
  let writes = 0
  const tx = { query: async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT output')) return { rows: [pending] }
    if (sql.includes('FROM factory_tasks t JOIN factory_attempts a')) return { rows: [] }
    if (sql.includes('FROM coordinator_events')) return { rows: [] }
    if (sql.includes('FROM factory_attempts')) {
      assert.deepEqual(args, [task.id, pending.position, task.sourceEventId])
      return { rows: options.previous === false ? [] : [failed] }
    }
    if (sql.includes('FROM factory_candidates c')) return { rows: options.context === false ? [] : [{
      id: 'repair-run', botId: 'bot', prompt: original, repository: 'https://github.com/owner/current.git',
      candidateRepository: 'https://github.com/owner/current.git', candidateSha: 'a'.repeat(40), producerRunId: 'producer-run',
    }] }
    if (sql.startsWith('UPDATE agent_runs SET prompt')) {
      writes++
      prompt = String(args[1]) + (typeof args[2] === 'number' ? original.slice(0, args[2]) : original)
      return { rows: [], rowCount: 1 }
    }
    throw new Error('Unexpected repair query: ' + sql)
  } } as unknown as PoolClient
  return { tx, task, failed, pending, read: () => ({ prompt, writes }) }
}

for (const flowVersion of [1, 2] as const) for (const stage of ['review', 'verify'] as const) test(`v${flowVersion} automatic ${stage} repair carries the fixed host context and keeps a false finding distinct from the original criterion`, async () => {
  const f = repairBriefFixture({ stage, flowVersion })
  const before = structuredClone({ pending: f.pending, failed: f.failed })
  const configured = await factoryRepairBrief(f.tx, f.task, 'repair-run')
  assert.deepEqual(configured, { preservePrompt: true }, 'later handoff composition must preserve the complete automatic repair request')
  const { prompt, writes } = f.read()
  assert.equal(writes, 1, 'required visual guidance and trusted repair context commit together')
  assert.match(prompt, /Every implementation must produce at least one ready visual capture, video by default/)
  assert.match(prompt, /submit_result\.visualEvidence/)
  assert.equal(prompt.includes('Factory implementation owns validation'), flowVersion === 2)
  assert.match(prompt, /Factory stage: execute \(automatic repair\)/)
  assert.match(prompt, new RegExp(`Failed ${stage} attempt failed-attempt, run failed-run, session failed-session`))
  assert.match(prompt, /Current host repository: https:\/\/github.com\/owner\/current.git/)
  assert.match(prompt, /fixed-candidate/)
  assert.match(prompt, new RegExp('a'.repeat(40)))
  assert.match(prompt, /producer-run/)
  assert.ok(prompt.includes(failedRepairClaim))
  assert.ok(prompt.endsWith(originalRepairRequest))
  assert.match(prompt, /failed report does not change the original user request or acceptance criteria/)
  assert.match(prompt, /verify its findings against the original criteria and actual candidate/)
  assert.doesNotMatch(prompt, /Coordinator model decision|synthetic-secret-finding/)
  assert.deepEqual({ pending: f.pending, failed: f.failed }, before, 'brief must not invent a model decision or alter the old report')
})

for (const flowVersion of [1, 2] as const) test(`v${flowVersion} ordinary execute receives required visual guidance without invented repair context`, async () => {
  const f = repairBriefFixture({ previous: false, flowVersion })
  await factoryRepairBrief(f.tx, f.task, 'repair-run')
  const { prompt, writes } = f.read()
  assert.equal(writes, 1)
  assert.match(prompt, /Every implementation must produce at least one ready visual capture, video by default/)
  assert.match(prompt, /report_blocked with the specific reason/)
  assert.match(prompt, /submit_result\.visualEvidence/)
  assert.doesNotMatch(prompt, /automatic repair|Failed review attempt|Coordinator model decision/)
  assert.ok(prompt.endsWith(originalRepairRequest))
  assert.equal(prompt.includes('Factory implementation owns validation'), flowVersion === 2)
})

for (const flowVersion of [1, 2] as const) test(`v${flowVersion} automatic repair refuses missing host/candidate context before writing its prompt`, async () => {
  const f = repairBriefFixture({ context: false, flowVersion })
  await assert.rejects(factoryRepairBrief(f.tx, f.task, 'repair-run'), (error: unknown) => error instanceof FactoryError && error.code === 'factoryCheckBindingMismatch')
  assert.equal(f.read().writes, 0)
})

for (const flowVersion of [1, 2] as const) test(`v${flowVersion} automatic repair reserves mandatory guidance and bounds only failure excerpts, preserving the original request`, async () => {
  const original = originalRepairRequest + 'x'.repeat(96000) + '\nFinal standing constraint: never change the exact target.'
  const f = repairBriefFixture({ prompt: original, flowVersion })
  f.failed.output.completion.findings[0].evidence = 'observation '.repeat(5000)
  await factoryRepairBrief(f.tx, f.task, 'repair-run')
  const { prompt, writes } = f.read()
  assert.equal(writes, 1)
  assert.match(prompt, /Every implementation must produce at least one ready visual capture, video by default/)
  assert.ok(prompt.endsWith(original))
  assert.ok(prompt.length <= 100000)
  assert.ok(prompt.includes('Failure excerpt truncated'))
})

for (const flowVersion of [1, 2] as const) test(`v${flowVersion} automatic repair fails without a prompt write when guidance and context cannot fit beside the untouched original request`, async () => {
  const original = 'x'.repeat(100000)
  const f = repairBriefFixture({ prompt: original, flowVersion })
  await assert.rejects(factoryRepairBrief(f.tx, f.task, 'repair-run'), (error: unknown) => error instanceof FactoryError && error.code === 'factoryCheckBindingMismatch')
  assert.deepEqual(f.read(), { prompt: original, writes: 0 })
})
