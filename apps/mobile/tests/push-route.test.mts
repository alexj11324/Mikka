// A push about a task's thread opens the task, then that attempt (decisions/2026-11-07-2045-tasks-only-threads-inside.md).
import assert from 'node:assert/strict'
import test from 'node:test'
import { pushTarget, taskLinkAttempt } from '../lib/push-route.ts'

const run = '11111111-1111-4111-8111-111111111111'
const task = '22222222-2222-4222-8222-222222222222'
const bot = '33333333-3333-4333-8333-333333333333'

test('a thread of a task opens the task at that attempt', () => {
  assert.equal(pushTarget({ runId: run, issueId: task, botId: bot }), `/task/${task}?attempt=${run}`)
  assert.equal(pushTarget({ issueId: task }), `/task/${task}`)
})

test('a thread without a task opens the thread; a proposal its card; anything else the chat', () => {
  assert.equal(pushTarget({ runId: run }), `/thread/${run}`)
  assert.equal(pushTarget({ pendingActionId: run, issueId: task, botId: bot }), `/bots/${bot}?action=${run}`)
  assert.equal(pushTarget({ botId: bot }), `/bots/${bot}`)
  assert.equal(pushTarget({ issueId: 'not-a-uuid' }), '/bots/coordinator')
})

test('a task-scoped link opens only an attempt belonging to the authorized Task detail', () => {
  const detail = { task: { id: task }, activity: [{ kind: 'created' }, { kind: 'attempt', runId: run }] }
  assert.equal(taskLinkAttempt(task, run, detail), run)
  assert.equal(taskLinkAttempt(task, bot, detail), null)
  assert.equal(taskLinkAttempt(task, run, { ...detail, activity: [] }), null)
  assert.equal(taskLinkAttempt(bot, run, detail), undefined)
  assert.equal(taskLinkAttempt(task, run, null), undefined)
  assert.equal(taskLinkAttempt(task, undefined, detail), undefined)
})
