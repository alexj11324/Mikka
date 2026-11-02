import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOT_THREADS, BOTS, ISSUES, RUNS } from './content.mjs'
import { assertEveryRunHasIssue, threadIssues, withIssues } from './thread-issues.mjs'

// The same shape seed.mjs gives each bot's extra threads.
const threads = Object.entries(BOT_THREADS).flatMap(([bot, list]) => list.map(([title, status], index) => ({ key: `t-${bot}-${index}`, issue: null, bot, status, prompt: title })))
const runs = [...RUNS, ...threads]

test('every demo thread is backed by a task (dispatch_run never runs without one)', () => {
  const created = threadIssues(runs)
  const linked = withIssues(runs)
  const keys = new Set([...ISSUES, ...created].map(issue => issue.key))
  assert.equal(keys.size, ISSUES.length + created.length, 'task keys stay unique')
  assert.ok(linked.every(run => run.issue && keys.has(run.issue)), 'each run points at a task that will be seeded')
  assert.equal(created.length, runs.filter(run => !run.issue).length)
})

test('a thread task is the Bot\'s, titled by the thread, with a board status its run implies', () => {
  const statuses = new Set(['backlog', 'todo', 'doing', 'review', 'done', 'canceled', 'duplicate'])
  const bots = new Set(BOTS.map(bot => `bot:${bot.key}`))
  for (const issue of threadIssues(runs)) {
    assert.ok(bots.has(issue.assignee), `${issue.key} is assigned to an existing Bot`)
    assert.ok(statuses.has(issue.status), `${issue.key} has a board status`)
    assert.ok(issue.title.length > 0)
  }
  const [running] = threadIssues([{ key: 'x', bot: 'frontend', status: 'running', prompt: '深色模式：报表图表配色' }])
  assert.deepEqual({ status: running.status, title: running.title, assignee: running.assignee }, { status: 'doing', title: '深色模式：报表图表配色', assignee: 'bot:frontend' })
})

test('the seeder refuses a run without a task', () => {
  assert.throws(() => assertEveryRunHasIssue([{ key: 'r-1', issueId: 'a' }, { key: 'r-2', issueId: null }]), /r-2/)
  assert.doesNotThrow(() => assertEveryRunHasIssue([{ key: 'r-1', issueId: 'a' }]))
})
