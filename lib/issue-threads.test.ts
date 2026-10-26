import assert from 'node:assert/strict'
import test from 'node:test'
import { canReadThread, projectIssueThreads, threadName } from './issue-threads'

const make = (id: string, userId = 'teammate', issueId = 'issue') => ({
  id, issueId, userId, status: 'running', prompt: 'Route group replies\nthen run e2e', report: { summary: 'Done' }, error: null,
  createdAt: new Date('2026-01-01'), finishedAt: null, agentName: 'Mikka Backend', harness: 'codex',
})

test('a workspace issue shares every collaborator thread, with its name, agent and summary', () => {
  const [team] = projectIssueThreads([make('team')], 'issue', 'viewer', new Set(['teammate', 'viewer']), true)
  assert.equal(team.ownedByCurrentUser, false)
  assert.deepEqual(team.detail, { name: 'Route group replies', agentName: 'Mikka Backend', harness: 'codex', summary: 'Done' })
})

test('a personal issue shows another owner only that a thread exists', () => {
  const result = projectIssueThreads([make('team'), make('mine', 'viewer')], 'issue', 'viewer', new Set(['teammate', 'viewer']), false)
  assert.equal(result.find(row => row.id === 'team')?.detail, null)
  assert.ok(result.find(row => row.id === 'mine')?.detail)
  assert.ok(!JSON.stringify(result.find(row => row.id === 'team')).includes('Route'))
})

test('other issues, removed owners and removed viewers see nothing', () => {
  assert.deepEqual(projectIssueThreads([make('other', 'teammate', 'other-issue'), make('removed', 'removed')], 'issue', 'viewer', new Set(['viewer', 'teammate']), true), [])
  assert.deepEqual(projectIssueThreads([make('team')], 'issue', 'removed-viewer', new Set(['teammate']), true), [])
  assert.equal(canReadThread('teammate', 'removed-viewer', new Set(['teammate']), true), false)
  assert.equal(canReadThread('removed', 'viewer', new Set(['viewer']), true), false)
})

test('threads are latest first and bounded to twenty', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ ...make(String(i)), createdAt: new Date(2026, 0, i + 1) }))
  const result = projectIssueThreads(rows, 'issue', 'viewer', new Set(['viewer', 'teammate']), true)
  assert.equal(result.length, 20); assert.equal(result[0].id, '29'); assert.equal(result[19].id, '10')
})

test('a thread is named by the first line it was asked, shortened, else by its agent', () => {
  assert.equal(threadName('\n  Fix the board  \nmore', 'Agent'), 'Fix the board')
  assert.equal(threadName('', 'Mikka Backend'), 'Mikka Backend')
  assert.equal(Array.from(threadName('长'.repeat(80), 'x')).length, 60)
})
