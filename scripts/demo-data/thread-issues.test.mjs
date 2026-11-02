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

test('the backfill gives each task-less demo run a workspace task held by its Bot, and writes nothing twice', async () => {
  const { applyBackfill, backfillPlan } = await import('./backfill-issues.mjs')
  const run = { id: 'de300000-0000-4000-8000-000000000001', status: 'running', prompt: '深色模式：报表图表配色\n细节', createdAt: new Date(0), updatedAt: new Date(1), botId: 'de300000-0000-4000-8000-0000000000b0', botName: '前端助手', workspaceId: 'de300000-0000-4000-8000-0000000000a0', teamId: 'de300000-0000-4000-8000-0000000000c0' }
  const calls = []
  const client = { query: async (sql, values) => { calls.push({ sql, values }); return sql.trimStart().startsWith('SELECT') ? { rows: [run] } : { rowCount: 1 } } }
  const [task] = await backfillPlan(client, 'owner-1')
  assert.match(calls[0].sql, /r\."issueId" IS NULL/)
  assert.match(calls[0].sql, /kind IS DISTINCT FROM 'group_chat'/)
  assert.deepEqual(calls[0].values, ['owner-1', 'de300000-%'])
  assert.equal(task.title, '深色模式：报表图表配色')
  assert.equal(task.status, 'doing')
  assert.deepEqual(task.content.attrs.mikka.assignee, { kind: 'agent', id: run.botId, name: '前端助手', image: null })
  assert.ok(task.issueId.startsWith('de300000-'))
  assert.equal((await backfillPlan(client, 'owner-1'))[0].issueId, task.issueId, 'the same run always gets the same task id')
  const written = await applyBackfill(client, 'owner-1', [task])
  assert.deepEqual(written, { issues: 1, issue_versions: 1, mikka_team_issues: 1, agent_runs: 1 })
  const update = calls.find(call => call.sql.includes('UPDATE agent_runs'))
  assert.match(update.sql, /"issueId" IS NULL/)
  assert.match(update.sql, /id::text LIKE \$4/)
  assert.ok(calls.filter(call => call.sql.includes('INSERT')).every(call => call.sql.includes('ON CONFLICT')))
})
