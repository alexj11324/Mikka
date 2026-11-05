import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { fakeWorkflowRuntime } from '../../tests/support/fake-workflow'
import type { WebTick } from './steps'

// The web subagent's loop on a virtual Workflow clock: a waiting task re-checks
// when its row changes (a wake), not every 30 s; work keeps its 1 s pacing (#1212).
const fake = fakeWorkflowRuntime()
mock.method(Date, 'now', fake.now)
mock.module('workflow', { namedExports: fake.exports })
mock.module('workflow/api', { namedExports: { resumeHook: async (token: string) => fake.resume(token) } })

let script: (n: number) => WebTick = () => 'terminal'
const ticks: number[] = []
const tick = mock.fn(async () => { ticks.push(fake.now()); return script(ticks.length) })
const expire = mock.fn(async () => {})
mock.module(new URL('./steps.ts', import.meta.url).href, { namedExports: { tick, expire } })

import { wakeTokens } from '../../lib/workflow-wake-tokens'
let workflow: typeof import('./workflow')
before(async () => { workflow = await import('./workflow') })
beforeEach(() => { ticks.length = 0; tick.mock.resetCalls(); expire.mock.resetCalls() })
const actor = { userId: 'owner', workspaceId: 'workspace' }
const since = () => ticks.map(at => (at - ticks[0]) / 1000)

test('browser work keeps its one-second pacing between actions', async () => {
  script = n => n <= 3 ? 'running' : 'terminal'
  await Promise.all([workflow.webSubagentWorkflow(actor, 'bot', 'work'), fake.advance(10_000)])
  assert.deepEqual(since(), [0, 1, 2, 3])
})

test('a task waiting on a person re-checks 31 times an hour, where the 30 s tick re-read 120 times', async () => {
  let done = false
  script = () => done ? 'terminal' : 'waiting'
  const running = workflow.webSubagentWorkflow(actor, 'bot', 'idle')
  await fake.advance(60 * 60_000)
  assert.equal(ticks.length, 31)
  done = true
  await fake.advance(workflow.SUBAGENT_WAIT_FALLBACK_MS)
  await running
})

test('a stop or an approval wakes the waiting task at once: it reaches its next state on the wake', async () => {
  let stopped = false
  script = () => stopped ? 'terminal' : 'waiting'
  const running = workflow.webSubagentWorkflow(actor, 'bot', 'stop-me')
  await fake.advance(45_000)
  const stoppedAt = fake.now()
  stopped = true
  fake.resume(wakeTokens.subagent('stop-me'))
  await fake.settle()
  await running
  assert.equal(ticks.at(-1), stoppedAt, 'reported on the wake, not 30 s later')
})

test('a lost wake still reaches the final state at the fallback', async () => {
  let stopped = false
  script = () => stopped ? 'terminal' : 'waiting'
  const running = workflow.webSubagentWorkflow(actor, 'bot', 'lost')
  await fake.advance(10_000)
  stopped = true // its wake never arrives
  await fake.advance(workflow.SUBAGENT_WAIT_FALLBACK_MS)
  await running
  assert.deepEqual(since(), [0, workflow.SUBAGENT_WAIT_FALLBACK_MS / 1000])
})

test('a failed step retries at the row\'s own next attempt, and a task left waiting a week expires', async () => {
  const start = fake.now()
  script = n => n === 1 ? { retryAt: start + 4_000 } : n === 2 ? { retryAt: start + 12_000 } : 'terminal'
  await Promise.all([workflow.webSubagentWorkflow(actor, 'bot', 'retry'), fake.advance(60_000)])
  assert.deepEqual(since(), [0, 4, 12])

  ticks.length = 0
  script = () => 'waiting'
  await Promise.all([workflow.webSubagentWorkflow(actor, 'bot', 'forgotten'), fake.advance(workflow.SUBAGENT_WAIT_BUDGET_MS + workflow.SUBAGENT_WAIT_FALLBACK_MS)])
  assert.equal(expire.mock.callCount(), 1)
  assert.equal(ticks.length, workflow.SUBAGENT_WAIT_BUDGET_MS / workflow.SUBAGENT_WAIT_FALLBACK_MS)
})
