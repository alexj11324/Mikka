import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
import type { PoolClient } from 'pg'
import { emptyRunReport } from '@mikka/protocol/run'
import { FactoryError } from './factory/contract'
import { ImprovementError } from './self-improvement/contract'

const trace: string[] = []
const client = { query: async (query: string) => { trace.push(query); return { rows: [] } } } as unknown as PoolClient
const run = { id: 'run', userId: 'owner', botId: 'bot' }
const originalReport = { ...emptyRunReport(), execution: {} } as ReturnType<typeof emptyRunReport>
const sanitized = { ...emptyRunReport(), summary: 'Validated evidence' }
let mountError: Error | null = null, monitorError: Error | null = null, questionError: Error | null = null
const authorizeEvaluation = async () => true
const validateExecution = async () => {}
const mount = mock.fn(async (..._args: unknown[]) => { trace.push('mount'); if (mountError) throw mountError; return sanitized })
const monitor = mock.fn(async () => { trace.push('monitor'); if (monitorError) throw monitorError })
const question = (prefix = '') => ({
  settle: mock.fn(async () => { trace.push(prefix + 'settle'); if (questionError) throw questionError }),
  record: mock.fn(async () => { trace.push(prefix + 'record') }),
})
const questions = question(), scopedQuestions = question('bot-')
const runtime = mock.fn(() => ({ questions: scopedQuestions }))
const stub = (path: string, exports: Record<string, unknown>) => mock.module(new URL(path, import.meta.url).href, { exports })
stub('./self-improvement/registry.ts', { lockSkillScope: async () => {} })
stub('./self-improvement/skill-mounts.ts', { recordCompletionSkillMount: mount })
stub('./self-improvement/server.ts', { skillEvaluations: { authorizeEvaluation, validateExecution } })
stub('./issue-access.ts', { issueForUser: async () => ({ id: 'issue' }) })
stub('./factory/server.ts', { factoryMonitor: { probeRun: monitor }, factoryQuestions: questions })
stub('./factory/runtime.ts', { factoryRuntimeForBot: runtime })
let effects: typeof import('./run-completion-effects')
const environment = { routing: process.env.MIKKA_FACTORY_ROUTING_ENABLED, lifecycle: process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED }
before(async () => { effects = await import('./run-completion-effects') })
beforeEach(() => {
  trace.length = 0; mountError = null; monitorError = null; questionError = null
  for (const fn of [mount, monitor, questions.settle, questions.record, scopedQuestions.settle, scopedQuestions.record, runtime]) fn.mock.resetCalls()
  delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED
})
after(() => {
  if (environment.routing === undefined) delete process.env.MIKKA_FACTORY_ROUTING_ENABLED; else process.env.MIKKA_FACTORY_ROUTING_ENABLED = environment.routing
  if (environment.lifecycle === undefined) delete process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED; else process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = environment.lifecycle
})

test('skill validation and monitor receive the same transaction and the validated report', async () => {
  assert.equal(await effects.prepareRunCompletionEffects(client, run, { stopReason: 'submitted', report: originalReport }, true), sanitized)
  const args = mount.mock.calls[0].arguments
  assert.deepEqual(args.slice(0, 5), [client, 'owner', 'run', 'submitted', originalReport])
  assert.equal(args[6], authorizeEvaluation)
  assert.equal(args[7], validateExecution)
  assert.deepEqual(monitor.mock.calls[0].arguments, ['owner', 'run', client, sanitized])
  assert.deepEqual(trace, ['mount', 'SAVEPOINT completion_monitor_probe', 'monitor', 'RELEASE SAVEPOINT completion_monitor_probe'])
})

test('invalid evidence stops before a monitor effect and unexpected probe errors propagate', async () => {
  mountError = new ImprovementError('sourceMismatch')
  await assert.rejects(effects.prepareRunCompletionEffects(client, run, { stopReason: 'submitted', report: originalReport }, true), /sourceMismatch/)
  assert.deepEqual(trace, ['mount'])
  mountError = null; trace.length = 0; monitorError = new Error('database failure')
  await assert.rejects(effects.prepareRunCompletionEffects(client, run, { stopReason: 'submitted', report: originalReport }, true), /database failure/)
  assert.deepEqual(trace.slice(-2), ['ROLLBACK TO SAVEPOINT completion_monitor_probe', 'RELEASE SAVEPOINT completion_monitor_probe'])
})

test('an expected optional Factory rejection rolls back only its savepoint', async () => {
  monitorError = new FactoryError('factoryMonitorProbeUnavailable')
  assert.equal(await effects.prepareRunCompletionEffects(client, run, { stopReason: 'submitted', report: originalReport }, true), sanitized)
  assert.deepEqual(trace.slice(-2), ['ROLLBACK TO SAVEPOINT completion_monitor_probe', 'RELEASE SAVEPOINT completion_monitor_probe'])
})

test('ordinary unbound completions do not invoke Factory effects', async () => {
  const report = emptyRunReport()
  assert.equal(await effects.prepareRunCompletionEffects(client, run, { stopReason: 'submitted', report }, false), report)
  await effects.settleRunCompletionEffects(client, run, 'blocked', false)
  assert.deepEqual(trace, [])
})

test('question settlement and handoff use the existing completion transaction and scoped bot', async () => {
  process.env.MIKKA_FACTORY_ROUTING_ENABLED = '1'; process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '1'
  await effects.settleRunCompletionEffects(client, run, 'asked_human', true)
  assert.deepEqual(runtime.mock.calls[0].arguments, ['bot'])
  assert.deepEqual(scopedQuestions.settle.mock.calls[0].arguments, ['owner', 'run', client])
  assert.deepEqual(scopedQuestions.record.mock.calls[0].arguments, ['owner', 'run', client])
  assert.deepEqual(trace, ['SAVEPOINT completion_question_settle', 'bot-settle', 'RELEASE SAVEPOINT completion_question_settle', 'SAVEPOINT completion_question_record', 'bot-record', 'RELEASE SAVEPOINT completion_question_record'])
})

test('known stale question state can settle without consuming a new handoff on submissions', async () => {
  questionError = new FactoryError('factoryQuestionClosed')
  await effects.settleRunCompletionEffects(client, run, 'submitted', true)
  assert.deepEqual(trace, ['SAVEPOINT completion_question_settle', 'settle', 'ROLLBACK TO SAVEPOINT completion_question_settle', 'RELEASE SAVEPOINT completion_question_settle'])
  assert.equal(questions.record.mock.callCount(), 0)
})
