import assert from 'node:assert/strict'
import test from 'node:test'
import { groupThreads, pullRequestsOf, replyLine } from './thread-groups'

const thread = (id: string, status: string, issueId: string | null = null) => ({ id, status, issueId })
const ids = (rows: { id: string }[]) => rows.map(row => row.id)

test('a reply opening is one line, verbatim otherwise', () => {
  assert.equal(replyLine('  修好了，PR 已开。\n\n三条检查都通过。 '), '修好了，PR 已开。 三条检查都通过。')
  assert.equal(replyLine(' \n '), null)
  assert.equal(replyLine(null), null)
})

test('threads group as 等待回复, 进行中, 空闲, 已解决', () => {
  const statuses: Record<string, string> = { open: 'review', closed: 'done' }
  const groups = groupThreads([
    thread('ask', 'waiting_input'), thread('broke', 'failed'), thread('work', 'running'), thread('queued', 'queued'),
    thread('stop', 'stopped'), thread('gone', 'cancelled'),
    thread('review', 'succeeded', 'open'), thread('older', 'succeeded', 'open'),
    thread('shipped', 'succeeded', 'closed'), thread('free', 'succeeded'), thread('lost', 'succeeded', 'deleted'),
  ], id => statuses[id])
  assert.deepEqual(ids(groups.waiting), ['ask', 'broke', 'review'])
  assert.deepEqual(ids(groups.running), ['work', 'queued'])
  assert.deepEqual(ids(groups.idle), ['stop', 'gone'])
  // Only the newest thread on an open task waits; an older one on it is done.
  assert.deepEqual(ids(groups.resolved), ['older', 'shipped', 'free', 'lost'])
})

test('a bot\'s PRs come from the tasks its threads worked on', () => {
  const pr = (number: number, state: 'open' | 'merged' | 'closed') => ({ url: `https://github.com/acme/app/pull/${number}`, state })
  const issues = [
    { id: 'a', metadata: { pullRequests: [pr(247, 'open')] } },
    { id: 'b', metadata: { pullRequests: [pr(251, 'open'), pr(250, 'closed')] } },
    { id: 'c', metadata: { pullRequests: [pr(240, 'merged')] } },
    { id: 'other', metadata: { pullRequests: [pr(9, 'open')] } },
  ]
  const rows = pullRequestsOf([thread('1', 'succeeded', 'a'), thread('2', 'running', 'b'), thread('3', 'succeeded', 'c'), thread('4', 'succeeded', 'b'), thread('5', 'running')], issues)
  assert.deepEqual(rows.map(row => [row.number, row.group, row.issueId]), [[247, 'review', 'a'], [251, 'running', 'b'], [240, 'merged', 'c']])
})
