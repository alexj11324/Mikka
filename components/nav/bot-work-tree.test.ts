import test from 'node:test'
import assert from 'node:assert/strict'
import { botWorkTree } from './bot-work-tree'

const issue = (id: string, status = 'doing') =>
  ({ id, status, identifier: `MIK-${id}`, title: `Task ${id}`, metadata: { pullRequests: [] } }) as never
const run = (id: string, issueId: string | null, botId: string | null = 'bot', status = 'running', createdAt = id, source: 'mcp' | null = null) =>
  ({ id, botId, issueId, status, createdAt, source, outcome: null, agentName: 'Codex', harness: 'codex', prompt: 'Standalone work\nPrivate detail' }) as never

test('a Bot contains one row per task, and the latest run decides its own task state', () => {
  const tree = botWorkTree('workspace', ['bot'], [run('1', 'a'), run('2', 'a', 'bot', 'waiting_input')], [issue('a')])
  const rows = tree.get('bot')!
  assert.equal(rows.length, 1)
  assert.equal(rows[0].name, 'MIK-a Task a')
  assert.equal(rows[0].state, 'waiting')
  assert.equal(rows[0].reason, 'needsReply')
  assert.deepEqual(rows[0].runs.map(item => item.id), ['2', '1'])
})

test('another workspace, unknown Bots and MCP runs cannot enter the tree', () => {
  const tree = botWorkTree('workspace', ['bot', 'coordinator'], [run('a', 'foreign', 'other-workspace-bot'), run('b', 'missing'), run('c', null, 'other-bot'), run('d', 'own', 'bot', 'running', 'd', 'mcp')], [issue('foreign'), issue('own')])
  assert.equal(tree.size, 0)
  assert.equal(botWorkTree(null, ['bot'], [run('a', null)], []).size, 0)
})

test('owner-wide legacy runs with no dispatching Bot cannot be attributed to the selected workspace', () => {
  const tree = botWorkTree('workspace', ['coordinator'], [run('a', 'own', null), run('b', null, null)], [issue('own')])
  assert.equal(tree.size, 0)
})

test('switching workspace uses its Bot roster, even when the owner-wide run and task lists retain both', () => {
  const runs = [run('a', 'one', 'bot-one'), run('b', 'two', 'bot-two')]
  const issues = [issue('one'), issue('two')]
  assert.deepEqual([...botWorkTree('one', ['bot-one'], runs, issues).keys()], ['bot-one'])
  assert.deepEqual([...botWorkTree('two', ['bot-two'], runs, issues).keys()], ['bot-two'])
})

test('a direct Agent execution keeps its work name and opens by run id; no task state is invented', () => {
  const row = botWorkTree('workspace', ['bot'], [run('a', null)], []).get('bot')![0]
  assert.equal(row.issueId, null)
  assert.equal(row.name, 'Standalone work')
  assert.equal(row.state, null)
  assert.deepEqual(row.runs, [{ id: 'a', name: 'Codex', harness: 'codex' }])
})

test('a closed task stays closed while its run is active', () => {
  const row = botWorkTree('workspace', ['bot'], [run('a', 'closed')], [issue('closed', 'done')]).get('bot')![0]
  assert.equal(row.state, 'done')
})
