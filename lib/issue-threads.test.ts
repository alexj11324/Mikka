import assert from 'node:assert/strict'
import test from 'node:test'
import { canReadThread, projectIssueThreads, threadName, threadQuestionRunId, threadQuestionView, threadTime, withRunChain } from './issue-threads'
import type { RunChain } from './run-chain'

const make = (id: string, userId = 'teammate', issueId = 'issue') => ({
  id, issueId, userId, status: 'running', prompt: 'Route group replies\nthen run e2e', report: { summary: 'Done' }, error: null,
  createdAt: new Date('2026-01-01'), finishedAt: null, agentName: 'Mikka Backend', harness: 'codex', ownerName: userId === 'viewer' ? 'Me' : 'Lin',
})

test('a teammate thread shows whose it is, its status and time, never its content', () => {
  const [team] = projectIssueThreads([make('team')], 'issue', 'viewer', new Set(['teammate', 'viewer']))
  assert.equal(team.ownedByCurrentUser, false)
  assert.equal(team.ownerName, 'Lin')
  assert.equal(team.status, 'running')
  assert.equal(team.detail, null)
  assert.ok(!/Route|Mikka Backend|codex|Done/.test(JSON.stringify(team)))
  assert.equal(canReadThread('teammate', 'viewer', new Set(['teammate', 'viewer'])), false)
})

test('the owner reads their own thread in full', () => {
  const [mine] = projectIssueThreads([make('mine', 'viewer')], 'issue', 'viewer', new Set(['teammate', 'viewer']))
  assert.equal(mine.ownerName, null)
  assert.deepEqual(mine.detail, { name: 'Route group replies', agentName: 'Mikka Backend', harness: 'codex', summary: 'Done', bot: null })
})

test('stopping is shared status metadata and disappears when the daemon acknowledges', () => {
  const row = { ...make('stopping'), stopRequestedAt: new Date('2026-01-01T00:00:01Z') }
  const members = new Set(['viewer', 'teammate'])
  const [live] = projectIssueThreads([row], 'issue', 'viewer', members)
  assert.equal(live.stopping, true)
  assert.equal(live.detail, null)
  assert.ok(!('stopRequestedAt' in live), 'the private timestamp stays out of teammate metadata')
  const [ended] = projectIssueThreads([{ ...row, status: 'stopped' }], 'issue', 'viewer', members)
  assert.equal(ended.stopping, false)
})

test('a Bot display name or Bot identifier cannot replace the thread owner', () => {
  const row = { ...make('bot-run', 'owner'), agentName: 'My Bot', botId: 'viewer' }
  const members = new Set(['owner', 'viewer'])
  const [mine] = projectIssueThreads([row], 'issue', 'owner', members)
  assert.equal(mine.detail?.agentName, 'My Bot')
  const [foreign] = projectIssueThreads([row], 'issue', 'viewer', members)
  assert.equal(foreign.ownedByCurrentUser, false)
  assert.equal(foreign.detail, null)
  assert.equal(canReadThread(row.userId, row.botId, members), false)
})

test('other issues, removed owners and removed viewers see nothing', () => {
  assert.deepEqual(projectIssueThreads([make('other', 'teammate', 'other-issue'), make('removed', 'removed')], 'issue', 'viewer', new Set(['viewer', 'teammate'])), [])
  assert.deepEqual(projectIssueThreads([make('team')], 'issue', 'removed-viewer', new Set(['teammate'])), [])
  assert.equal(canReadThread('teammate', 'removed-viewer', new Set(['teammate'])), false)
  assert.equal(canReadThread('viewer', 'viewer', new Set(['teammate'])), false)
})

test('threads are latest first and bounded to twenty', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ ...make(String(i)), createdAt: new Date(2026, 0, i + 1) }))
  const result = projectIssueThreads(rows, 'issue', 'viewer', new Set(['viewer', 'teammate']))
  assert.equal(result.length, 20); assert.equal(result[0].id, '29'); assert.equal(result[19].id, '10')
})

test('a thread is named by the first line it was asked, shortened, else by its agent', () => {
  assert.equal(threadName('\n  Fix the board  \nmore', 'Agent'), 'Fix the board')
  assert.equal(threadName('', 'Mikka Backend'), 'Mikka Backend')
  assert.equal(Array.from(threadName('长'.repeat(80), 'x')).length, 60)
})

test('a resumed question is one thread: its run chain folds the continuation into the origin row, named as the origin', () => {
  const members = new Set(['viewer'])
  const origin = { ...make('origin', 'viewer'), status: 'succeeded', prompt: 'Speed up the home page', createdAt: new Date('2026-01-01T00:00:00Z') }
  const attempt = (runId: string, n: number, status: string, minute: number) => ({ runId, attempt: n, status, stopRequestedAt: null, createdAt: new Date(`2026-01-01T00:0${minute}:00Z`), finishedAt: null })
  const chain = (status: string): RunChain => ({ rootRunId: 'origin', latestRunId: 'next', attempts: [attempt('origin', 1, 'succeeded', 0), attempt('next', 2, status, 5)] })
  // The read path lists chain roots only (lib/run-chain.ts listIssueRunChains); the continuation is an attempt, not a row.
  const threads = projectIssueThreads([origin], 'issue', 'viewer', members).map(thread => withRunChain(thread, chain('queued')))
  assert.deepEqual(threads.map(thread => thread.id), ['origin'])
  assert.equal(threads[0].detail?.name, 'Speed up the home page')
  assert.deepEqual([threads[0].rootRunId, threads[0].latestRunId, threads[0].attempts.map(a => a.runId)], ['origin', 'next', ['origin', 'next']])
  assert.deepEqual(threads[0].continuation, { id: 'next', status: 'queued', stopping: false })
  // Queued continuation: its question is read on the run it resumes, and it reads 运行中, nothing to send or stop yet.
  assert.equal(threadQuestionRunId(threads[0]), 'origin')
  const queued = threadQuestionView({ ...threads[0], question: 'resuming' })
  assert.deepEqual([queued.question, queued.status, queued.runId, queued.stopping], ['resuming', 'running', 'next', false])
  // Started: the continuation (latestRunId) is the live run that send and stop address.
  const [started] = projectIssueThreads([origin], 'issue', 'viewer', members).map(thread => withRunChain(thread, chain('running')))
  assert.equal(threadQuestionRunId(started), null)
  const live = threadQuestionView({ ...started, question: null })
  assert.deepEqual([live.question, live.status, live.runId], [null, 'running', started.latestRunId])
  // The continuation ended on a new question: the thread waits again, keyed on the continuation.
  const [asked] = projectIssueThreads([origin], 'issue', 'viewer', members).map(thread => withRunChain(thread, chain('stopped')))
  assert.equal(threadQuestionRunId(asked), 'next')
  const again = threadQuestionView({ ...asked, question: 'waiting' })
  assert.deepEqual([again.question, again.waiting, again.status, again.runId], ['waiting', true, 'stopped', 'next'])
  // A queued rerun with no answered question is just the queued live run, still stoppable from the thread.
  const rerun = threadQuestionView({ ...threads[0], question: null })
  assert.deepEqual([rerun.question, rerun.status, rerun.runId], [null, 'queued', 'next'])
})

test('a one-run thread is its own chain: the question is read on it once it ended, never while live', () => {
  const [running] = projectIssueThreads([make('solo', 'viewer')], 'issue', 'viewer', new Set(['viewer']))
  assert.deepEqual([running.rootRunId, running.latestRunId, running.continuation], ['solo', 'solo', null])
  assert.equal(threadQuestionRunId(running), null)
  const [ended] = projectIssueThreads([{ ...make('solo', 'viewer'), status: 'stopped' }], 'issue', 'viewer', new Set(['viewer']))
  assert.equal(threadQuestionRunId(withRunChain(ended, null)), 'solo')
  assert.deepEqual(threadQuestionView({ ...ended, question: 'waiting' }), { question: 'waiting', waiting: true, status: 'stopped', runId: 'solo', stopping: false })
})

test('a continuation without its origin in view never shows raw markdown as its name', () => {
  // Its origin is outside the chain's scope (another owner or issue), so it is its own root.
  const [orphan] = projectIssueThreads([{ ...make('next', 'viewer'), prompt: '# Thread question abc' }], 'issue', 'viewer', new Set(['viewer']))
  assert.equal(orphan.detail?.name, 'Thread question abc')
  assert.equal(threadName('## **Ship** it', 'x'), 'Ship it')
})

test('a thread time is never in the future relative to now', () => {
  const now = new Date('2026-01-01T00:00:00Z')
  assert.equal(threadTime({ createdAt: new Date('2026-01-01T00:00:01Z'), finishedAt: null }, now).getTime(), now.getTime())
  assert.equal(threadTime({ createdAt: new Date('2025-12-31T23:59:00Z'), finishedAt: null }, now).getTime(), new Date('2025-12-31T23:59:00Z').getTime())
})
