import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { projectIssueRunSummaries } from './issue-run-summary'
const make = (id: string, userId = 'teammate', issueId = 'issue') => ({ id, issueId, userId, status: 'running', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-02'), report: { secret: 'private' }, prompt: 'private', error: 'private', chunks: ['private'], agentName: 'private' })
test('current collaborators see whitelisted summaries and no private owner/agent/output fields', () => {
  const result = projectIssueRunSummaries([make('team'), make('mine', 'viewer')], 'issue', 'viewer', new Set(['teammate', 'viewer']))
  assert.equal(result.find(row => row.id === 'team')?.ownedByCurrentUser, false)
  assert.equal(result.find(row => row.id === 'mine')?.ownedByCurrentUser, true)
  for (const row of result) assert.deepEqual(Object.keys(row).sort(), ['id', 'status', 'createdAt', 'updatedAt', 'ownedByCurrentUser'].sort())
  assert.ok(!JSON.stringify(result).includes('private'))
})
test('different issues and removed owners are excluded, including a removed issue owner', () => {
  assert.deepEqual(projectIssueRunSummaries([make('other', 'teammate', 'other-issue'), make('removed', 'removed'), make('former-owner', 'former-owner')], 'issue', 'viewer', new Set(['viewer', 'teammate'])), [])
})
test('summaries are latest first, bounded to twenty and reveal no total count', () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ ...make(String(i)), createdAt: new Date(2026, 0, i + 1) }))
  const result = projectIssueRunSummaries(rows, 'issue', 'viewer', new Set(['viewer', 'teammate']))
  assert.equal(result.length, 20); assert.equal(result[0].id, '29'); assert.equal(result[19].id, '10')
})
test('action guards issue access before any summary query and preserves owner-only detail/control actions', () => {
  const actions = readFileSync('app/actions/agents.ts', 'utf8')
  const action = actions.slice(actions.indexOf('export async function listIssueRunSummaries'), actions.indexOf('export async function getRun'))
  assert.ok(action.indexOf('await requireIssueAccess(issueId)') < action.indexOf('await workspaceDb.select'))
  assert.match(action, /eq\(workspaceMembers.status, 'active'\)/)
  assert.match(action, /eq\(agentRuns.issueId, issue.id\), inArray\(agentRuns.userId, memberIds\)/)
  assert.match(actions, /return readRun\(await getUserId\(\), runId\)/)
  assert.match(actions, /await addRunMessage\(await getUserId\(\), input\)/)
  assert.match(actions, /await requestRunStop\(await getUserId\(\), runId\)/)
})

test('removed or unaffiliated viewers receive no summaries', () => {
  assert.deepEqual(projectIssueRunSummaries([make('team')], 'issue', 'removed-viewer', new Set(['teammate'])), [])
})
