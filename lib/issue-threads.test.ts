import assert from 'node:assert/strict'
import test from 'node:test'
import { canReadThread, projectIssueThreads, threadName } from './issue-threads'

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
  assert.deepEqual(mine.detail, { name: 'Route group replies', agentName: 'Mikka Backend', harness: 'codex', summary: 'Done' })
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
