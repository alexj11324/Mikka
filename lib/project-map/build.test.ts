import assert from 'node:assert/strict'
import { test } from 'node:test'
import { branchAncestry, buildMapGraph, layoutMap, pathHighlight, type MapIssueInput } from './build'

let clock = 0
function issue(id: string, extra: Partial<MapIssueInput> = {}): MapIssueInput {
  clock += 1
  const at = new Date(Date.UTC(2026, 9, 1, 0, clock)).toISOString()
  return { id, status: 'done', createdAt: at, updatedAt: at, duplicateOfId: null, parentId: null, blockedByIds: [], ...extra }
}
const shape = (rows: ReturnType<typeof layoutMap>['rows']) => rows.map(row => row.kind === 'node' ? `${row.id}@${row.lane}` : row.kind === 'fork' ? `◆${row.parentId}@${row.lane}` : `+${row.branchId}@${row.lane}`)

test('issues without relations form one straight main line in creation order', () => {
  const graph = buildMapGraph([issue('a'), issue('b'), issue('c', { status: 'doing' })])
  assert.deepEqual(graph.mainLine, ['a', 'b', 'c'])
  assert.equal(graph.currentId, 'c')
  const layout = layoutMap(graph, { maxLane: 2 })
  assert.deepEqual(shape(layout.rows), ['a@0', 'b@0', 'c@0'])
  assert.deepEqual(layout.lanes, [{ lane: 0, from: 0, to: 2, kind: 'main' }])
  assert.equal(layout.branches.length, 0)
})

test('an abandoned branch forks off its predecessor and the live option continues the lane', () => {
  const graph = buildMapGraph([issue('a'), issue('b'), issue('x', { parentId: 'b', status: 'canceled' }), issue('c', { blockedByIds: ['b'], status: 'doing' })])
  assert.deepEqual(graph.mainLine, ['a', 'b', 'c'])
  assert.ok(graph.branchAbandoned.has('x'))
  const layout = layoutMap(graph, { maxLane: 2 })
  assert.deepEqual(shape(layout.rows), ['a@0', 'b@0', '◆b@0', 'x@1', 'c@0'])
  const fork = layout.rows[2]
  assert.ok(fork.kind === 'fork' && fork.chosenId === 'c' && fork.otherIds.join() === 'x' && !fork.parallel)
  assert.deepEqual(layout.branches, [{ fromLane: 0, from: 2, toLane: 1, to: 3, kind: 'abandoned' }])
  assert.deepEqual(layout.lanes.find(line => line.lane === 1), { lane: 1, from: 3, to: 3, kind: 'abandoned' })
  assert.deepEqual(layout.lanes.find(line => line.lane === 0), { lane: 0, from: 0, to: 4, kind: 'main' })
})

test('a fork whose other option is still live is parallel', () => {
  const graph = buildMapGraph([issue('a'), issue('b', { blockedByIds: ['a'], status: 'doing' }), issue('c', { blockedByIds: ['a'], status: 'doing' })])
  const fork = layoutMap(graph, { maxLane: 2 }).rows.find(row => row.kind === 'fork')
  assert.ok(fork?.kind === 'fork' && fork.parallel)
  assert.equal(graph.continues.get('a'), 'c', 'equal activity: the newest continues')
})

test('nested forks open one lane further right, and a finished branch frees its lane', () => {
  // a → b(fork: rf abandoned branch with its own fork into xg/sp) → m → (fork: cd live branch with its own fork) → r
  const graph = buildMapGraph([
    issue('a'), issue('b'),
    issue('rf', { parentId: 'b', status: 'canceled' }),
    issue('xg', { parentId: 'rf', status: 'canceled' }),
    issue('sp', { parentId: 'rf', status: 'canceled' }),
    issue('m', { blockedByIds: ['b'] }),
    issue('cd', { parentId: 'm' }),
    issue('ls', { parentId: 'cd', status: 'canceled' }),
    issue('s2', { parentId: 'cd', status: 'doing' }),
    issue('r', { blockedByIds: ['m'], status: 'doing' }),
  ])
  assert.deepEqual(graph.mainLine, ['a', 'b', 'm', 'r'])
  const layout = layoutMap(graph, { maxLane: 2 })
  assert.deepEqual(shape(layout.rows), ['a@0', 'b@0', '◆b@0', 'rf@1', '◆rf@1', 'xg@2', 'sp@1', 'm@0', '◆m@0', 'cd@1', '◆cd@1', 'ls@2', 's2@1', 'r@0'])
  assert.equal(layout.width, 2)
  const lane1 = layout.lanes.filter(line => line.lane === 1)
  assert.deepEqual(lane1, [{ lane: 1, from: 3, to: 6, kind: 'abandoned' }, { lane: 1, from: 9, to: 12, kind: 'live' }], 'lane 1 is reused after the first branch ends')
  assert.deepEqual(branchAncestry(graph, 'ls'), ['cd', 'ls'])
  assert.deepEqual(branchAncestry(graph, 's2'), ['cd'])
  const path = pathHighlight(graph, layout, 's2')
  assert.deepEqual([...path.rows].sort((x, y) => x - y), [0, 1, 7, 9, 12])
  assert.deepEqual(path.branches, [{ fromLane: 0, from: 8, toLane: 1, to: 9, kind: 'live' }])
})

test('a branch deeper than the drawn lanes folds into one row; a phone folds sooner', () => {
  const issues = [issue('a'), issue('b1', { parentId: 'a', status: 'canceled' }), issue('b2', { parentId: 'b1', status: 'canceled' }), issue('b3', { parentId: 'b2', status: 'canceled' }), issue('b4', { parentId: 'b2', status: 'canceled' }), issue('a2', { blockedByIds: ['a'] })]
  const graph = buildMapGraph(issues)
  const phone = layoutMap(graph, { maxLane: 1 })
  assert.deepEqual(shape(phone.rows), ['a@0', '◆a@0', 'b1@1', 'b2@1', '◆b2@1', '+b3@2', 'b4@1', 'a2@0'])
  const fold = phone.rows[5]
  assert.ok(fold.kind === 'fold' && fold.deep && fold.count === 1 && fold.abandoned)
  assert.deepEqual(shape(layoutMap(graph, { maxLane: 1, focusId: 'b3' }).rows), ['b3@0'])
})

test('folding a branch by hand, or folding all, keeps the fork and shows a step count', () => {
  const graph = buildMapGraph([issue('a'), issue('x', { parentId: 'a', status: 'canceled' }), issue('y', { parentId: 'x', status: 'canceled' }), issue('b', { blockedByIds: ['a'] })])
  assert.deepEqual(shape(layoutMap(graph, { maxLane: 2, folded: new Set(['x']) }).rows), ['a@0', '◆a@0', '+x@1', 'b@0'])
  const all = layoutMap(graph, { maxLane: 2, foldAll: true }).rows
  assert.ok(all[2].kind === 'fold' && all[2].count === 2 && !all[2].deep)
})

test('predecessor precedence: duplicate, then parent, then the newest blocker', () => {
  const graph = buildMapGraph([issue('a'), issue('b'), issue('c'), issue('d', { duplicateOfId: 'a', parentId: 'b', blockedByIds: ['c'], status: 'duplicate' }), issue('e', { parentId: 'b', blockedByIds: ['c'] }), issue('f', { blockedByIds: ['a', 'c'] })])
  assert.equal(graph.predecessor.get('d'), 'a')
  assert.equal(graph.predecessor.get('e'), 'b')
  assert.equal(graph.predecessor.get('f'), 'c')
})

test('relations outside the map, to itself, or closing a loop are ignored', () => {
  const graph = buildMapGraph([issue('a', { blockedByIds: ['b'] }), issue('b', { blockedByIds: ['a'] }), issue('c', { parentId: 'gone', duplicateOfId: 'c' })])
  // a's blocker b is accepted first; b's blocker a would close a loop, so b follows the spine.
  assert.equal(graph.predecessor.get('a'), 'b')
  assert.equal(graph.predecessor.get('b'), null)
  assert.equal(graph.rootId, 'b')
  assert.equal(graph.predecessor.get('c'), 'b')
  assert.equal(new Set(graph.order).size, 3)
})

test('the main line follows the most recently active subtree, not the oldest', () => {
  const a = issue('a')
  const old = issue('old', { parentId: 'a' })
  const fresh = issue('fresh', { parentId: 'a', status: 'doing' })
  old.updatedAt = new Date(Date.UTC(2026, 10, 3)).toISOString()
  fresh.updatedAt = new Date(Date.UTC(2026, 10, 1)).toISOString()
  const child = issue('child', { parentId: 'fresh', status: 'doing' })
  child.updatedAt = new Date(Date.UTC(2026, 10, 4)).toISOString()
  assert.deepEqual(buildMapGraph([a, old, fresh, child]).mainLine, ['a', 'fresh', 'child'])
})

test('an empty project and a one-issue project', () => {
  const empty = buildMapGraph([])
  assert.equal(empty.rootId, null)
  assert.deepEqual(layoutMap(empty, { maxLane: 2 }).rows, [])
  const one = buildMapGraph([issue('only', { status: 'doing' })])
  assert.deepEqual(shape(layoutMap(one, { maxLane: 2 }).rows), ['only@0'])
  assert.equal(one.currentId, 'only')
})
