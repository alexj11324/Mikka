import assert from 'node:assert/strict'
import test from 'node:test'
import { localTaskState } from '@/hooks/use-bot-tasks'
import { newestThreadRun } from './task-state-icon'

const at = (iso: string) => new Date(iso)

test('a task\'s state comes from its newest thread\'s live run, not an older one', () => {
  assert.equal(newestThreadRun(undefined), null)
  assert.equal(newestThreadRun([]), null)
  const threads = [
    { id: 'a', status: 'succeeded', outcome: 'done', createdAt: at('2026-11-10T01:00:00Z'), continuation: null },
    { id: 'b', status: 'succeeded', outcome: 'needs_input', createdAt: at('2026-11-10T02:00:00Z'), continuation: null },
  ]
  assert.deepEqual(newestThreadRun(threads), { status: 'succeeded', outcome: 'needs_input' })
  assert.deepEqual(newestThreadRun([...threads].reverse()), { status: 'succeeded', outcome: 'needs_input' })
  // An answered question's continuation is the live run.
  const resumed = [{ ...threads[1], continuation: { status: 'running', outcome: null } }]
  assert.deepEqual(newestThreadRun(resumed), { status: 'running', outcome: null })
  // ALEX-45: In Review on the board and its newest thread asked a question: one state, 等你回复.
  assert.deepEqual(localTaskState({ status: 'review', metadata: { pullRequests: [] } }, { status: 'waiting_input', outcome: null }), { state: 'waiting', reason: 'needsReply' })
})
