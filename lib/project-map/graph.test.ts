import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { projectGraph, graphOverview, graphPage, graphPath, matchingNodes } from './graph'
import { mapQuerySchema, type DecisionFact, type MapFacts } from './read-contracts'
const id = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const at = (n: number) => new Date(Date.UTC(2026, 10, 5, 0, 0, n)).toISOString()
const option = (id: string, disposition: 'selected' | 'retained' = 'retained') => ({ id, title: id, disposition, reason: null, derivedFrom: null, stoppedAtSourceRef: null })
function decision(n: number, values: Partial<DecisionFact> = {}): DecisionFact {
  return { id: id(n), issueId: id(2), runId: null, factoryTaskId: null, kind: 'choose', title: 'Choice ' + n,
    summary: 'Keep evidence', reason: 'A deliberate choice', options: [option('a', 'selected'), option('b')],
    selectedOptionId: 'a', contextOptionRef: null, predecessorDecisionIds: [], provenance: 'recorded', captureMode: 'live',
    occurredAt: at(n), recordedAt: at(n), supersedesId: null, recordStatus: 'active', sources: [],
    decidedBy: { kind: 'human', id: 'owner' }, recordedBy: { kind: 'agent', id: 'run' }, ...values }
}
const source = (n: number, run: number, optionId: string | null, role = 'branch_work') => ({ sourceRef: id(n), role, optionId,
  relation: 'host_verified' as const, availability: 'available' as const, locator: { type: 'run' as const, id: id(run), runId: id(run), issueId: id(2) } })
function fixture(): MapFacts {
  return {
    project: { id: id(1), title: 'Map', revision: 1, createdAt: at(0) }, issues: [{ id: id(2), title: 'Task', status: 'todo', createdAt: at(1) }],
    runs: [20, 21, 22, 23].map((n, index) => ({ id: id(n), issueId: id(2), status: index === 0 ? 'failed' : 'succeeded', outcome: null,
      createdAt: at(n), finishedAt: null, retryOf: n === 21 ? id(20) : null, continuesRunId: null, harness: 'codex', modelId: 'gpt-6-luna', owned: true })),
    candidates: [], checks: [], artifacts: [], publications: [],
    decisions: [
      decision(3, { sources: [source(100, 20, 'b')] }),
      decision(4, { contextOptionRef: { decisionId: id(3), optionId: 'b' }, sources: [source(101, 22, 'b')] }),
      decision(5, { kind: 'abandon', options: [], selectedOptionId: null, contextOptionRef: { decisionId: id(4), optionId: 'b' },
        sources: [source(102, 22, null, 'stopped_at')], reason: 'The alternative lacks evidence' }),
      decision(6, { contextOptionRef: { decisionId: id(4), optionId: 'a' }, sources: [source(103, 23, 'b')] }),
    ],
  }
}
test('independent work has no fabricated chronological predecessor; a failed retry is not abandoned', () => {
  const graph = projectGraph(fixture())
  assert.ok(graph.edges.some(e => e.from === 'project:' + id(1) && e.to === 'issue:' + id(2)))
  assert.equal(graph.edges.some(e => e.from === 'issue:' + id(2) && e.to === 'decision:' + id(3)), false)
  assert.equal(graph.branches.find(b => b.id === 'option:' + id(3) + ':b')!.status, 'active')
  assert.equal(graph.nodes.find(n => n.id === 'run:' + id(21))!.branchId, 'option:' + id(3) + ':b')
  assert.equal(graph.nodes.find(n => n.id === 'run:' + id(20))!.status, 'failed')
})
test('nested forks use the right lane, preserve mobile folds and focus a folded route', () => {
  const desktop = projectGraph(fixture(), 3), mobile = projectGraph(fixture(), 2)
  const node = (g: ReturnType<typeof projectGraph>, n: number) => g.nodes.find(x => x.id === 'run:' + id(n))!
  assert.equal(node(desktop, 20).lane, 1)
  assert.equal(node(desktop, 22).lane, 2)
  assert.equal(node(mobile, 22).lane, null)
  assert.deepEqual(desktop.nodes.map(n => [n.id, n.order]), mobile.nodes.map(n => [n.id, n.order]))
  const fold = mobile.folds.find(f => f.branchIds.includes('option:' + id(4) + ':b'))!
  assert.ok(fold); assert.ok(fold.anchor.lane < 2)
  const focused = projectGraph(fixture(), 2, fold.expand.branchId)
  assert.equal(node(focused, 22).lane, 0)
  assert.ok(focused.focus!.breadcrumbs.length >= 2)
})
test('abandoning selected A then redirecting C leaves the common root and historical choice intact', () => {
  const facts = fixture()
  facts.decisions = [decision(3), decision(4, { kind: 'abandon', options: [], selectedOptionId: null, contextOptionRef: { decisionId: id(3), optionId: 'a' }, reason: 'A is unsuitable' }),
    decision(5, { kind: 'redirect', options: [option('c', 'selected')], selectedOptionId: 'c', predecessorDecisionIds: [id(4)] })]
  const graph = projectGraph(facts)
  assert.equal(graph.branches.find(b => b.id === 'main:' + id(1))!.status, 'active')
  assert.equal(graph.branches.find(b => b.id === 'option:' + id(3) + ':a')!.status, 'abandoned')
  assert.equal(graph.branches.find(b => b.id === 'option:' + id(5) + ':c')!.status, 'active')
  assert.equal(graph.nodes.find(n => n.id === 'decision:' + id(3))!.decision!.options[0].disposition, 'selected')
})
test('a late abandon with an earlier stop stays reachable in all and abandoned pages', () => {
  const facts = fixture()
  facts.runs = facts.runs.filter(run => [id(20), id(22)].includes(run.id))
  facts.runs[0].status = 'stopped'; facts.runs[0].outcome = 'asked_human'
  facts.runs[1].createdAt = at(40)
  const abandoned = { ...option('a'), disposition: 'abandoned' as const }
  facts.decisions = [
    decision(3, { options: [option('a', 'selected'), { ...option('b'), disposition: 'rejected' }], sources: [source(100, 20, 'a')] }),
    decision(30, { kind: 'redirect', options: [option('c', 'selected'), { ...option('a'), disposition: 'rejected' }], selectedOptionId: 'c',
      contextOptionRef: { decisionId: id(3), optionId: 'a' }, predecessorDecisionIds: [id(3)], sources: [source(101, 22, 'c')] }),
    decision(45, { kind: 'abandon', options: [abandoned], selectedOptionId: null,
      contextOptionRef: { decisionId: id(3), optionId: 'a' }, predecessorDecisionIds: [id(3), id(30)] }),
    decision(50, { kind: 'abandon', options: [abandoned], selectedOptionId: null, supersedesId: id(45),
      contextOptionRef: { decisionId: id(3), optionId: 'a' }, predecessorDecisionIds: [id(3), id(30)],
      sources: [{ ...source(102, 20, 'a', 'stopped_at'), locator: { type: 'question', id: id(103), runId: id(20), issueId: id(2) } }] }),
  ]
  const branchId = 'option:' + id(50) + ':a', endId = 'end:' + branchId
  for (const laneLimit of [2, 3] as const) {
    const graph = projectGraph(facts, laneLimit)
    for (const filter of ['all', 'abandoned'] as const) {
      const query = mapQuerySchema.parse({ workspaceId: id(10), laneLimit, filter, limit: 100 })
      const whole = graphPage(graph, query)
      assert.equal(whole.folds.length, 0)
      assert.equal(whole.page.hasMore, false)
      assert.equal(whole.nodes.length, whole.page.matchedCount, 'every match must be reachable without folds or another page')
      assert.ok(whole.nodes.some(node => node.id === endId))
      assert.ok(whole.nodes.every(node => node.lane !== null && node.lane >= 0 && node.lane < laneLimit))
      for (const limit of [1, 3]) {
        const visited: string[] = []
        let after = -1
        for (let count = 0; count < graph.nodes.length; count++) {
          const page = graphPage(graph, { ...query, limit }, after)
          visited.push(...page.nodes.map(node => node.id))
          assert.equal(page.folds.length, 0)
          if (!page.page.hasMore) break
          assert.ok(page.lastOrder > after)
          after = page.lastOrder
        }
        assert.deepEqual(visited, whole.nodes.map(node => node.id))
        assert.equal(new Set(visited).size, whole.page.matchedCount)
      }
    }
    const end = graph.nodes.find(node => node.id === endId)!, fork = graph.nodes.find(node => node.id === 'decision:' + id(50))!
    assert.ok(end.order > fork.order, 'a terminal marker cannot precede the decision that creates its branch')
    assert.equal(graph.branches.find(branch => branch.id === branchId)!.stoppedAtNodeId, 'run:' + id(20))
    assert.equal(graph.branches.find(branch => branch.id === 'option:' + id(3) + ':a')!.stoppedAtNodeId, 'run:' + id(20))
    const path = graphPath(graph, endId)
    assert.ok(path.nodes.some(node => node.id === fork.id))
    assert.ok(path.nodes.some(node => node.id === 'run:' + id(20)))
  }
})
test('every page edge endpoint is in the page or its authorized boundary, without duplicates', () => {
  const graph = projectGraph(fixture()), query = mapQuerySchema.parse({ workspaceId: id(10), limit: 1 })
  let after = -1
  const visited = new Set<string>()
  for (let page = 0; page < graph.nodes.length; page++) {
    const result = graphPage(graph, query, after), ids = new Set([...result.nodes, ...result.boundaryNodes].map(n => n.id))
    for (const edge of result.edges) { assert.ok(ids.has(edge.from)); assert.ok(ids.has(edge.to)) }
    for (const node of result.nodes) { assert.ok(!visited.has(node.id)); visited.add(node.id) }
    after = result.lastOrder
    if (!result.page.hasMore) break
  }
  assert.equal(visited.size, graph.nodes.filter(n => n.lane !== null).length)
})
test('paths retain every explicit merge ancestor; search and minimap preserve the original order', () => {
  const facts = fixture()
  facts.decisions.push(decision(7, { kind: 'merge', options: [], selectedOptionId: null, predecessorDecisionIds: [id(5), id(6)] }))
  const graph = projectGraph(facts, 2), path = graphPath(graph, 'decision:' + id(7))
  assert.ok(path.nodes.some(n => n.id === 'decision:' + id(5)))
  assert.ok(path.nodes.some(n => n.id === 'decision:' + id(6)))
  const query = mapQuerySchema.parse({ workspaceId: id(10), q: 'Choice 7' })
  assert.equal(matchingNodes(graph, query).length, 1)
  assert.equal(matchingNodes(graph, query)[0].order, graph.nodes.find(n => n.id === 'decision:' + id(7))!.order)
  assert.equal(graphOverview(graph, query).bins.reduce((sum, bin) => sum + bin.nodeCount, 0), 1)
})
test('corrupt cycles are diagnosed without hanging or returning back edges', () => {
  const facts = fixture(); facts.decisions[0].predecessorDecisionIds = [id(4)]
  const graph = projectGraph(facts)
  assert.ok(graph.coverage.issues.includes('lineage_cycle'))
  const order = new Map(graph.nodes.map(n => [n.id, n.order]))
  for (const edge of graph.edges) assert.ok(order.get(edge.from)! < order.get(edge.to)!)
})
test('500 and 1000 executions retain bounded pages and overview bins', t => {
  for (const count of [500, 1000]) {
    const facts = fixture(); facts.decisions = []
    facts.runs = Array.from({ length: count }, (_, n) => ({ id: id(n + 100), issueId: id(2), status: 'succeeded', outcome: 'done',
      createdAt: at(n), finishedAt: at(n + 1), retryOf: null, continuesRunId: n ? id(n + 99) : null, harness: 'codex', modelId: 'gpt-6-luna', owned: true }))
    const started = performance.now(), graph = projectGraph(facts), query = mapQuerySchema.parse({ workspaceId: id(10) })
    const page = graphPage(graph, query), overview = graphOverview(graph, query)
    assert.equal(page.nodes.length, 50); assert.ok(overview.bins.length <= 100)
    assert.ok(gzipSync(JSON.stringify(page)).byteLength < 150 * 1024)
    t.diagnostic(JSON.stringify({ count, projectionMs: performance.now() - started, pageBytes: Buffer.byteLength(JSON.stringify(page)), gzipBytes: gzipSync(JSON.stringify(page)).byteLength }))
  }
})

test('laneState transfers the selected route at the fork, before its first work node', () => {
  const graph = projectGraph(fixture()), fork = graph.nodes.find(node => node.id === 'decision:' + id(3))!
  const query = mapQuerySchema.parse({ workspaceId: id(10), limit: 1 })
  const page = graphPage(graph, query, fork.order - 1)
  assert.equal(page.nodes[0].id, fork.id)
  assert.deepEqual(page.laneState.after, [
    { lane: 0, branchId: 'option:' + id(3) + ':a' },
    { lane: 1, branchId: 'option:' + id(3) + ':b' },
  ])
  const next = graphPage(graph, query, fork.order)
  assert.deepEqual(next.laneState.before, page.laneState.after)
})
test('an explicit merge releases its route only after the merge; active failure never frees a parallel lane', () => {
  const facts = fixture()
  facts.decisions = [
    decision(3, { sources: [source(100, 20, 'b')] }),
    decision(25, { kind: 'merge', options: [], selectedOptionId: null,
      contextOptionRef: { decisionId: id(3), optionId: 'b' }, predecessorDecisionIds: [id(3)],
      sources: [source(101, 20, 'b', 'merges_from')] }),
    decision(30, { contextOptionRef: { decisionId: id(3), optionId: 'a' }, sources: [source(102, 23, 'b')] }),
  ]
  facts.runs = facts.runs.filter(run => [id(20), id(23)].includes(run.id))
  facts.runs[1].createdAt = at(40)
  const graph = projectGraph(facts, 2)
  assert.equal(graph.branches.find(branch => branch.id === 'option:' + id(3) + ':b')!.status, 'completed')
  assert.equal(graph.nodes.find(node => node.id === 'run:' + id(23))!.lane, 1)
  const merge = graph.nodes.find(node => node.id === 'decision:' + id(25))!
  const later = graph.nodes.find(node => node.id === 'run:' + id(23))!
  assert.ok(merge.order < later.order)
  const withoutMerge = projectGraph({ ...facts, decisions: [facts.decisions[0], facts.decisions[2]] }, 2)
  assert.equal(withoutMerge.nodes.find(node => node.id === 'run:' + id(23))!.lane, null)
})
test('dependency cycles remain diagnostic edges and never enter the causal path', () => {
  const facts = fixture()
  facts.issues.push({ id: id(8), title: 'Second task', status: 'todo', createdAt: at(2), blockedByIds: [id(2)] })
  facts.issues[0].blockedByIds = [id(8)]
  const graph = projectGraph(facts)
  assert.equal(graph.edges.filter(edge => edge.kind === 'depends_on').length, 2)
  assert.ok(graph.coverage.issues.includes('dependency_cycle'))
  assert.equal(graphPath(graph, 'issue:' + id(2)).nodes.some(node => node.id === 'issue:' + id(8)), false)
})
test('artifact search uses authorized names and folds count only matching nodes', () => {
  const facts = fixture()
  facts.artifacts.push({ id: id(800), versionId: id(801), version: 1, issueId: id(2), runId: id(22),
    title: '结果 Results report.md', kind: 'markdown', createdAt: at(40) })
  const graph = projectGraph(facts, 2)
  const query = mapQuerySchema.parse({ workspaceId: id(10), q: '结果 results' })
  assert.deepEqual(matchingNodes(graph, query).map(node => node.id), ['run:' + id(22)])
  const page = graphPage(graph, query)
  assert.equal(page.page.matchedCount, 1)
  assert.equal(page.folds.reduce((sum, fold) => sum + fold.nodeCount, 0), 1)
})
test('replacement facts retain route lineage without inventing abandonment', () => {
  const facts = fixture()
  facts.runs[0].threadReplacedBy = id(23)
  facts.decisions = [facts.decisions[0]]
  const graph = projectGraph(facts)
  assert.equal(graph.nodes.find(node => node.id === 'run:' + id(23))!.branchId, 'option:' + id(3) + ':b')
  assert.equal(graph.branches.find(branch => branch.id === 'option:' + id(3) + ':b')!.status, 'active')
  assert.ok(graphPath(graph, 'run:' + id(23)).nodes.some(node => node.id === 'run:' + id(20)))
})
test('correction and retraction never reactivate an old branch without current evidence', () => {
  const facts = fixture()
  facts.decisions = [decision(3), decision(4, { supersedesId: id(3), recordStatus: 'retracted', options: [], selectedOptionId: null, kind: 'confirm' })]
  const graph = projectGraph(facts)
  assert.equal(graph.nodes.some(node => node.type === 'decision'), false)
  assert.equal(graph.branches.length, 1)
  facts.decisions.push(decision(5, { contextOptionRef: { decisionId: id(3), optionId: 'a' } }))
  assert.ok(projectGraph(facts).coverage.issues.includes('missing_decision_context'))
})
test('branch cardinality is bounded even for many empty options', () => {
  const facts = fixture()
  facts.decisions = Array.from({ length: 101 }, (_, n) => decision(n + 100, {
    options: Array.from({ length: 20 }, (_, n) => option('x' + n, n ? 'retained' : 'selected')), selectedOptionId: 'x0',
  }))
  assert.throws(() => projectGraph(facts), (error: unknown) => (error as { code: string }).code === 'map_too_large')
})
