import assert from 'node:assert/strict'
import test from 'node:test'
import { agentStretches, taskConversationRoots, canReadThread, projectIssueThreads, taskFreeThreadMembers, threadName, threadQuestionRunId, threadQuestionView, threadTime, withRunChain } from './issue-threads'
import type { RunChain } from './run-chain'
import type { RunFailure } from '@mikka/protocol/run-failure'

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
  assert.deepEqual(mine.detail, { name: 'Route group replies', agentName: 'Mikka Backend', harness: 'codex', summary: 'Done', summarySource: 'report', bot: null })
})

test('the full owner detail identifies an error fallback without exposing private details to teammates', () => {
  const row = { ...make('empty-report', 'viewer'), status: 'succeeded', report: { summary: '' }, error: 'Previous error' }
  const members = new Set(['viewer', 'teammate'])
  const [own] = projectIssueThreads([row], 'issue', 'viewer', members)
  assert.equal(own.detail?.summary, 'Previous error')
  assert.equal(own.detail?.summarySource, 'error')
  const [foreign] = projectIssueThreads([row], 'issue', 'teammate', members)
  assert.equal(foreign.detail, null)
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
  assert.deepEqual(threads[0].continuation, { id: 'next', status: 'queued', outcome: null, stopping: false })
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
  assert.deepEqual(threadQuestionView({ ...ended, question: 'waiting' }), { question: 'waiting', waiting: true, status: 'stopped', outcome: null, runId: 'solo', stopping: false })
})

test('a committed question whose original machine could not wake shows failure on that same queued child', () => {
  const questionWake = { generation: '41500000-0000-4000-8000-000000000010', error: 'Original task machine unavailable' }
  const thread = { id: 'origin', status: 'stopped', question: 'resuming' as const,
    continuation: { id: 'child', status: 'queued', outcome: null, stopping: false }, questionWake }
  const before = structuredClone(thread)
  assert.deepEqual(threadQuestionView(thread), {
    question: 'resuming', waiting: false, status: 'failed', outcome: null, runId: 'child', stopping: false,
  })
  assert.deepEqual(thread, before, 'the presentation does not mark the queued run failed or replay its answer')
  assert.equal(threadQuestionView({ ...thread, questionWake: null }).status, 'running', 'a new wake generation returns to the existing resuming state')
})

test('a stale wake failure cannot replace a claimed continuation or an ordinary queued run', () => {
  const questionWake = { generation: '41500000-0000-4000-8000-000000000010', error: 'Original task machine unavailable' }
  const thread = { id: 'origin', status: 'stopped', question: 'resuming' as const,
    continuation: { id: 'child', status: 'running', outcome: null, stopping: false }, questionWake }
  assert.deepEqual(threadQuestionView(thread), {
    question: null, waiting: false, status: 'running', outcome: null, runId: 'child', stopping: false,
  })
  assert.equal(threadQuestionView({ ...thread, question: null, continuation: { ...thread.continuation, status: 'queued' } }).status, 'queued')
})

test('opening the queued child directly keeps its blocked question wake recoverable', () => {
  const questionWake = { generation: '41500000-0000-4000-8000-000000000010', error: 'Original task machine unavailable' }
  const [child] = projectIssueThreads([{ ...make('child', 'viewer'), status: 'queued' }], 'issue', 'viewer', new Set(['viewer']))
  const thread = withRunChain(child, { rootRunId: 'origin', latestRunId: 'child', attempts: [
    { runId: 'origin', attempt: 1, status: 'stopped', stopRequestedAt: null, createdAt: new Date(0), finishedAt: new Date(1) },
    { runId: 'child', attempt: 2, status: 'queued', stopRequestedAt: null, createdAt: new Date(2), finishedAt: null },
  ] })
  assert.equal(thread.continuation, null)
  assert.equal(threadQuestionRunId(thread), 'origin')
  assert.deepEqual(threadQuestionView({ ...thread, question: 'resuming', questionWake }), {
    question: 'resuming', waiting: false, status: 'failed', outcome: null, runId: 'child', stopping: false,
  })
  assert.equal(threadQuestionView({ ...thread, question: 'resuming', questionWake: null }).status, 'queued', 'an unfailed direct child retains its existing view')
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

test('a thread with no task: its owner reads it while an active member of its bot\'s workspace; nobody else does', () => {
  const bot = (members: string[] | null) => ({ workspaceMemberIds: members })
  // Owner, still an active member of the workspace of the bot that dispatched it.
  assert.equal(canReadThread('owner', 'owner', taskFreeThreadMembers('owner', bot(['owner', 'teammate']))), true)
  // A teammate in the same workspace sees no one else's thread (canReadThread, unchanged).
  assert.equal(canReadThread('owner', 'teammate', taskFreeThreadMembers('owner', bot(['owner', 'teammate']))), false)
  // The owner left the bot's workspace, or the workspace is gone: no one reads it.
  assert.equal(canReadThread('owner', 'owner', taskFreeThreadMembers('owner', bot(['teammate']))), false)
  assert.equal(canReadThread('owner', 'owner', taskFreeThreadMembers('owner', bot(null))), false)
  // No bot dispatched it: its owner alone.
  assert.equal(canReadThread('owner', 'owner', taskFreeThreadMembers('owner', null)), true)
  assert.equal(canReadThread('owner', 'stranger', taskFreeThreadMembers('owner', null)), false)
})

test('a thread with no task projects as itself, and never into a task\'s list', () => {
  const row = { id: 'run-free', issueId: null, userId: 'owner', status: 'succeeded', prompt: 'Draft the release notes', createdAt: new Date(0), finishedAt: null, agentName: 'Codex', harness: 'codex', ownerName: null, report: null, error: null, stopRequestedAt: null, outcome: null, botColor: null, botShape: null }
  const members = new Set(['owner'])
  assert.deepEqual(projectIssueThreads([row], null, 'owner', members).map(thread => thread.id), ['run-free'])
  assert.deepEqual(projectIssueThreads([row], 'task-1', 'owner', members), [])
})


test('thread lists expose only compact diagnostics, including the latest continuation', () => {
  const failure: RunFailure = { schemaVersion: 1, code: 'run_api_key_invalid', category: 'api_key', provider: 'openai', status: 401,
    providerMessage: 'private provider response', causes: [{ name: 'APIError' }], runId: 'root', appVersion: 'test', occurredAt: '2026-11-07T12:00:00.000Z' }
  const members = new Set(['viewer', 'teammate'])
  const [foreign] = projectIssueThreads([{ ...make('root'), failureDetails: failure }], 'issue', 'viewer', members)
  assert.equal(foreign.failureDetails?.code, 'run_api_key_invalid')
  assert.equal(foreign.detail, null)
  assert.doesNotMatch(JSON.stringify(foreign), /private provider response|APIError/)
  const [own] = projectIssueThreads([{ ...make('root', 'viewer'), failureDetails: failure }], 'issue', 'viewer', members)
  const chain: RunChain = { rootRunId: 'root', latestRunId: 'next', attempts: [
    { runId: 'root', attempt: 1, status: 'failed', failureDetails: failure, stopRequestedAt: null, createdAt: new Date(), finishedAt: new Date() },
    { runId: 'next', attempt: 2, status: 'failed', failureDetails: { ...failure, runId: 'next', code: 'run_quota_exceeded', category: 'quota' }, stopRequestedAt: null, createdAt: new Date(), finishedAt: new Date() },
  ] }
  const resumed = withRunChain(own, chain)
  assert.equal(resumed.failureDetails?.code, 'run_quota_exceeded')
  assert.equal(resumed.failureDetails?.runId, 'next')
  assert.doesNotMatch(JSON.stringify(resumed), /private provider response|APIError/)
  const succeeding = withRunChain(own, { ...chain, attempts: [chain.attempts[0], { ...chain.attempts[1], status: 'succeeded', failureDetails: null }] })
  assert.equal(succeeding.failureDetails, null, 'a successful continuation does not retain the root failure')
})

test('agentStretches joins consecutive threads by one Agent, oldest first (2026-11-09-0045)', () => {
  const t = (id: string, at: number, harness: string | null) => ({ id, createdAt: new Date(at), detail: harness ? { harness } : null })
  const out = agentStretches([t('c', 3, 'codex'), t('a', 1, 'claude_code'), t('b', 2, 'claude_code'), t('d', 4, 'claude_code'), t('h1', 5, null), t('h2', 6, null)])
  assert.deepEqual(out.map(s => [s.agent, s.first.id, s.last.id, s.ids]), [
    ['claude_code', 'a', 'b', ['a', 'b']], ['codex', 'c', 'c', ['c']], ['claude_code', 'd', 'd', ['d']], [null, 'h1', 'h2', ['h1', 'h2']],
  ])
  assert.deepEqual(agentStretches([]), [])
  // A Factory check by another Agent is its result card, not a switch.
  const checks = agentStretches([{ ...t('i', 1, 'claude_code'), kind: 'implement' }, { ...t('r', 2, 'codex'), kind: 'acceptance' }, { ...t('v', 3, 'claude_code'), kind: 'review' }])
  assert.deepEqual(checks.map(s => [s.agent, s.ids]), [['claude_code', ['i']]])
})

test('agentStretches also splits where the custom Agent 配置 changes (2026-11-10)', () => {
  const t = (id: string, at: number, profile: string | null) => ({ id, createdAt: new Date(at), detail: { harness: 'codex', profile: profile ? { id: profile } : null } })
  const out = agentStretches([t('a', 1, null), t('b', 2, 'review'), t('c', 3, 'review'), t('d', 4, 'docs'), t('e', 5, null)])
  assert.deepEqual(out.map(s => [s.profile, s.ids]), [[null, ['a']], ['review', ['b', 'c']], ['docs', ['d']], [null, ['e']]])
})

test('the newest visible conversational continuation owns replies even after a private run or a Factory check', () => {
  const visible = new Set(['teammate', 'viewer'])
  const [first] = projectIssueThreads([make('first', 'viewer')], 'issue', 'viewer', visible)
  const [later] = projectIssueThreads([make('second', 'viewer')], 'issue', 'viewer', visible)
  const [redacted] = projectIssueThreads([make('other')], 'issue', 'viewer', visible)
  first.latestRunId = 'resumed'
  first.attempts.push({ ...first.attempts[0], runId: 'resumed', createdAt: new Date('2026-01-03') })
  later.createdAt = new Date('2026-01-02')
  later.attempts[0].createdAt = later.createdAt
  const review = { ...later, id: 'review', kind: 'acceptance', createdAt: new Date('2026-01-04') }
  for (const list of [[redacted, later, review, first], [first, review, later, redacted]]) {
    const { readable, reply } = taskConversationRoots(list)
    assert.deepEqual(readable.map(run => run.id), ['first', 'second', 'review'])
    assert.equal(reply?.latestRunId, 'resumed')
  }
  assert.equal(taskConversationRoots([review, redacted]).reply, null)
})
