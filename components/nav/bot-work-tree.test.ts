import test from 'node:test'
import assert from 'node:assert/strict'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { taskPresentation, type TaskPresentation } from '@/lib/task-presentation'
import { botWorkTree } from './bot-work-tree'

type Issue = Parameters<typeof botWorkTree>[3][number]
type Thread = Parameters<typeof botWorkTree>[2][number]
const issue = (id: string, status = 'doing'): Issue => ({
  id, status, identifier: `MIK-${id}`, issuedIdentifier: `MIK-${id}`, title: `Task ${id}`, shortTitle: null,
  ownerId: 'owner', ownerName: 'Owner', ownerImage: null, teamId: null,
  workspaceId: 'workspace', projectId: null,
  scope: 'personal', priority: 'normal', revision: 1,
  createdAt: new Date('2026-11-10T00:00:00Z'), updatedAt: new Date('2026-11-10T00:00:00Z'),
  metadata: readIssueMetadata({ type: 'doc', content: [] }),
  checklist: { total: 0, checked: 0, percentage: 0 },
})
const run = (id: string, issueId: string | null, botId: string | null = 'bot', status: Thread['status'] = 'running', createdAt = id, source: Thread['source'] = null): Thread => ({
  id, botId, issueId, status, createdAt, updatedAt: createdAt, source, outcome: null,
  agentName: 'Codex', harness: 'codex', prompt: 'Standalone work\nPrivate detail', lastReply: null, lastReplyAt: null,
})

const present = (row: Issue, botIds: string[], projection?: Partial<TaskPresentation>): TaskPresentation => ({
  ...taskPresentation({ status: 'todo', metadata: row.metadata }, undefined, null, () => false),
  botDispatches: botIds.map(botId => ({ botId, runId: botId === 'bot' ? '2' : 'historical', harness: 'codex', name: botId })), ...projection,
})

test('historical dispatch and current dispatch share the workspace projection even without visible threads', () => {
  const a = issue('a'), unused = issue('unused')
  const projected = present(a, ['previous', 'bot'], { state: 'waiting', reason: 'pr_review', group: 'pending' })
  const tree = botWorkTree('workspace', ['previous', 'bot', 'unrelated'], [
    run('1', 'a'), run('2', 'a'), run('private', 'a', 'unrelated'), run('mcp', 'a', 'bot', 'running', 'z', 'mcp'),
  ], [a, unused], { a: projected, unused: present(unused, []) })
  for (const bot of ['previous', 'bot']) {
    const rows = tree.get(bot)!
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'MIK-a Task a')
    assert.equal(rows[0].state, projected.state)
    assert.equal(rows[0].reason, projected.reason)
    assert.deepEqual(rows[0].runs.map(item => item.id), bot === 'previous' ? ['historical'] : ['2', '1'])
  }
  assert.equal(tree.has('unrelated'), false)
})

test('a missing projection, an out-of-workspace issue or an unauthorized Bot cannot enter the tree', () => {
  const a = issue('a'), foreign = { ...issue('foreign'), workspaceId: 'another' }
  const runs = [run('a-run', 'a'), run('foreign-run', 'foreign'), run('other', null, 'another-bot'), run('null-bot', null, null)]
  const items = { foreign: present(foreign, ['bot']), a: present(a, ['another-bot']) }
  assert.equal(botWorkTree('workspace', ['bot'], runs, [a, foreign], items).size, 0)
  assert.equal(botWorkTree('workspace', ['bot'], runs, [a, foreign], {}).size, 0)
  assert.equal(botWorkTree(null, ['bot'], runs, [a, foreign], items).size, 0)
})
test('a direct Agent execution keeps its work name and opens by run id; no task state is invented', () => {
  const row = botWorkTree('workspace', ['bot'], [run('a', null)], [], {}).get('bot')![0]
  assert.equal(row.issueId, null)
  assert.equal(row.name, 'Standalone work')
  assert.equal(row.state, null)
  assert.deepEqual(row.runs, [{ id: 'a', name: 'Codex', harness: 'codex' }])
})

test('a closed task stays closed while its run is active', () => {
  const closed = issue('closed', 'done')
  const row = botWorkTree('workspace', ['bot'], [run('a', 'closed')], [closed], { closed: present(closed, ['bot'], { state: 'done' }) }).get('bot')![0]
  assert.equal(row.state, 'done')
})

test('sidebar task names use the existing short title and bound pending/manual titles; standalone runs are bounded too', () => {
  const generated = { ...issue('a'), title: '完整的任务需求原文不应该出现在紧凑的导航里面', shortTitle: '登录回调修复' }
  const pending = { ...issue('b'), title: '这是一个超过十二字限制的任务标题需要收短', shortTitle: null }
  const standalone = { ...run('c', null), prompt: 'one two three four five six seven eight' }
  const rows = botWorkTree('workspace', ['bot'], [run('a', 'a'), run('b', 'b'), standalone], [generated, pending], { a: present(generated, ['bot']), b: present(pending, ['bot']) }).get('bot')!
  assert.equal(rows[0].name, 'MIK-a 登录回调修复')
  assert.equal(rows[0].fullName, 'MIK-a 完整的任务需求原文不应该出现在紧凑的导航里面')
  assert.equal(rows[1].name, 'MIK-b 这是一个超过十二字限制的')
  assert.equal(rows[2].name, 'one two three four five six')
  assert.equal(generated.title, '完整的任务需求原文不应该出现在紧凑的导航里面')
})
