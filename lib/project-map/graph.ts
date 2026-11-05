import { createHash } from 'node:crypto'
import { MAP_NODE_LIMIT, MAP_BRANCH_LIMIT, MAP_EDGE_LIMIT, MapReadError, type MapBranch, type MapEdge, type MapFacts, type MapFold, type MapGraph, type MapNode, type MapQuery, type NodeStatus } from './read-contracts'

const rootId = (id: string) => 'project:' + id
const decisionId = (id: string) => 'decision:' + id
const branchId = (decision: string, option: string) => 'option:' + decision + ':' + option
const status = (value: string): NodeStatus => {
  if (['succeeded', 'completed', 'done', 'merged'].includes(value)) return 'completed'
  if (['running', 'working', 'started', 'active', 'preparing', 'finishing'].includes(value)) return 'active'
  if (['blocked', 'waiting', 'paused', 'needs_input', 'waiting_input'].includes(value)) return 'waiting'
  if (['failed', 'error'].includes(value)) return 'failed'
  if (['todo', 'queued', 'planned', 'backlog'].includes(value)) return 'planned'
  return 'unknown'
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
const byStableTime = (a: MapNode, b: MapNode) => a.occurredAt.localeCompare(b.occurredAt) || a.type.localeCompare(b.type) || a.id.localeCompare(b.id)

/** Only explicit lineage creates an edge. Time is a deterministic tie-breaker, never causation. */
export function projectGraph(facts: MapFacts, laneLimit: 2 | 3 = 3, focusBranchId?: string): MapGraph {
  const main = 'main:' + facts.project.id, root = rootId(facts.project.id)
  const nodes = new Map<string, MapNode>(), edges = new Map<string, MapEdge>(), branches = new Map<string, MapBranch>()
  const issues: string[] = []
  const selected = new Map<string, string>()
  const addNode = (id: string, type: MapNode['type'], title: string, occurredAt: string, state: string, result: string | null = null) => {
    const node: MapNode = { id, type, title, result, occurredAt, status: status(state), order: -1, branchId: main, lane: 0,
      detailAvailable: true, badges: { artifacts: 0, pullRequests: 0, checks: 0 }, decision: null }
    nodes.set(id, node); return node
  }
  const addEdge = (from: string, to: string, kind: MapEdge['kind'], evidence: MapEdge['evidence'] = 'host_verified') => {
    if (from === to || !nodes.has(from) || !nodes.has(to)) return
    const id = kind + ':' + from + ':' + to
    edges.set(id, { id, from, to, kind, evidence })
    if (edges.size > MAP_EDGE_LIMIT) throw new MapReadError('map_too_large', { detail: 'limit' })
  }
  branches.set(main, { id: main, parentBranchId: null, forkNodeId: null, optionRef: null, status: 'active', stoppedAtNodeId: null, reason: null, sourceRefs: [] })
  addNode(root, 'project', facts.project.title, facts.project.createdAt, 'active')
  for (const issue of facts.issues) addNode('issue:' + issue.id, 'task', issue.title, issue.createdAt, issue.status)
  for (const run of facts.runs) addNode('run:' + run.id, 'run', run.harness ?? 'run', run.createdAt, run.status, run.outcome)
  for (const candidate of facts.candidates) addNode('candidate:' + candidate.id, 'candidate', candidate.kind, candidate.createdAt, candidate.accepted ? 'completed' : 'unknown', candidate.sha)
  const superseded = new Set(facts.decisions.map(d => d.supersedesId).filter((id): id is string => id !== null))
  const decisions = facts.decisions.filter(d => d.recordStatus === 'active' && !superseded.has(d.id))
  const decisionSet = new Set(decisions.map(d => d.id))
  if (decisions.reduce((count, decision) => count + decision.options.length, 1) > MAP_BRANCH_LIMIT)
    throw new MapReadError('map_too_large', { detail: 'limit' })
  for (const decision of decisions) {
    const node = addNode(decisionId(decision.id), 'decision', decision.title, decision.occurredAt, 'completed', decision.summary)
    node.decision = { id: decision.id, provenance: decision.provenance, captureMode: decision.captureMode, selectedOptionId: decision.selectedOptionId,
      options: decision.options, reason: decision.reason, sourceRefs: decision.sources.map(source => 'source:' + source.sourceRef) }
    for (const option of decision.options) {
      const id = branchId(decision.id, option.id)
      branches.set(id, { id, parentBranchId: main, forkNodeId: node.id, optionRef: { decisionId: decision.id, optionId: option.id },
        status: option.disposition === 'rejected' ? 'not_taken' : option.disposition === 'abandoned' ? 'abandoned' : 'active',
        stoppedAtNodeId: option.disposition === 'rejected' ? node.id : null, reason: option.reason,
        sourceRefs: decision.sources.filter(s => s.optionId === option.id).map(s => 'source:' + s.sourceRef) })
      if (option.disposition === 'selected') selected.set(node.id, id)
    }
  }
  const sourceNode = (locator: NonNullable<MapFacts['decisions'][number]['sources'][number]['locator']>) => {
    const type = locator.type
    if (['candidate', 'commit'].includes(type)) return 'candidate:' + locator.id
    if (type === 'issue') return 'issue:' + locator.id
    if (type === 'run' || type === 'pull_request') return 'run:' + locator.id
    return locator.runId ? 'run:' + locator.runId : null
  }
  // A branch assignment with contradictory explicit evidence stays unknown on the root.
  const assignments = new Map<string, Set<string>>()
  const assign = (id: string, route: string) => {
    if (!nodes.has(id) || !branches.has(route)) return
    const routes = assignments.get(id) ?? new Set<string>(); routes.add(route); assignments.set(id, routes)
  }
  for (const decision of decisions) {
    const node = nodes.get(decisionId(decision.id))!
    const context = decision.contextOptionRef
    const parent = context ? branchId(context.decisionId, context.optionId) : main
    if (context && !branches.has(parent)) issues.push('missing_decision_context')
    if (branches.has(parent)) assign(node.id, parent)
    for (const option of decision.options) branches.get(branchId(decision.id, option.id))!.parentBranchId = branches.has(parent) ? parent : main
    for (const option of decision.options) if (option.derivedFrom && decisionSet.has(option.derivedFrom.decisionId))
      addEdge(decisionId(option.derivedFrom.decisionId), node.id, 'continues', 'declared')
    for (const previous of decision.predecessorDecisionIds) if (decisionSet.has(previous))
      addEdge(decisionId(previous), node.id, decision.kind === 'merge' ? 'merge' : 'continues', decision.provenance === 'inferred' ? 'inferred' : 'declared')
    if (context && decisionSet.has(context.decisionId)) addEdge(decisionId(context.decisionId), node.id, 'continues', 'declared')
    for (const source of decision.sources) {
      if (!source.locator || source.availability !== 'available') continue
      const id = sourceNode(source.locator)
      if (!id || !nodes.has(id)) continue
      const ownOption = source.optionId ? branchId(decision.id, source.optionId) : null
      const route = ownOption && branches.has(ownOption) ? ownOption : branches.has(parent) ? parent : main
      if (source.role === 'branch_work') {
        assign(id, route)
        addEdge(node.id, id, selected.get(node.id) === route ? 'continues' : 'fork', source.relation)
      }
      if (source.role === 'merges_from') addEdge(id, node.id, 'merge', source.relation)
      if (source.role === 'stopped_at') {
        const branch = branches.get(route)
        if (branch) branch.stoppedAtNodeId = id
      }
    }
    if (context && ['abandon', 'merge'].includes(decision.kind)) {
      const branch = branches.get(parent)
      if (branch) {
        branch.status = decision.kind === 'abandon' ? 'abandoned' : 'completed'
        branch.reason = decision.reason
        branch.sourceRefs = decision.sources.map(source => 'source:' + source.sourceRef)
        const stop = decision.sources.find(source => source.role === 'stopped_at' && source.locator)?.locator
        branch.stoppedAtNodeId = stop ? sourceNode(stop) : node.id
      }
    }
  }
  const runById = new Map(facts.runs.map(run => [run.id, run]))
  const replaced = new Map<string, string[]>()
  for (const run of facts.runs) if (run.threadReplacedBy && runById.has(run.threadReplacedBy)) {
    replaced.set(run.threadReplacedBy, [...(replaced.get(run.threadReplacedBy) ?? []), run.id])
    addEdge('run:' + run.id, 'run:' + run.threadReplacedBy, 'continues')
  }
  const resolving = new Set<string>()
  const inheritedRuns = new Map<string, string | null>()
  function inheritRun(id: string): string | null {
    if (inheritedRuns.has(id)) return inheritedRuns.get(id)!
    const explicit = assignments.get('run:' + id)
    if (explicit?.size === 1) return [...explicit][0]
    if (explicit && explicit.size > 1) return null
    if (resolving.has(id)) { issues.push('lineage_cycle'); return null }
    resolving.add(id)
    const run = runById.get(id), previous = run?.continuesRunId ?? run?.retryOf
    const predecessors = [...new Set([...(previous ? [previous] : []), ...(replaced.get(id) ?? [])])]
    const routes = new Set(predecessors.filter(previous => runById.has(previous)).map(inheritRun).filter((route): route is string => route !== null))
    if (routes.size > 1) issues.push('ambiguous_lineage')
    const inherited = routes.size === 1 ? [...routes][0] : null
    resolving.delete(id)
    if (inherited) assign('run:' + id, inherited)
    inheritedRuns.set(id, inherited)
    return inherited
  }
  for (const run of facts.runs) {
    inheritRun(run.id)
    const previous = run.continuesRunId ?? run.retryOf
    if (previous) addEdge('run:' + previous, 'run:' + run.id, 'continues')
  }
  for (const candidate of facts.candidates) {
    addEdge('run:' + candidate.runId, 'candidate:' + candidate.id, 'continues')
    const runRoute = assignments.get('run:' + candidate.runId)
    if (runRoute?.size === 1) assign('candidate:' + candidate.id, [...runRoute][0])
  }
  for (const check of facts.checks) if (check.candidateId && check.runId)
    addEdge('candidate:' + check.candidateId, 'run:' + check.runId, 'continues')
  for (const [id, routes] of assignments) {
    if (routes.size === 1) nodes.get(id)!.branchId = [...routes][0]
    else issues.push('ambiguous_lineage')
  }
  // Parent lane follows the decision's actual route, including nested contexts.
  for (const decision of decisions) for (const option of decision.options)
    branches.get(branchId(decision.id, option.id))!.parentBranchId = nodes.get(decisionId(decision.id))!.branchId
  for (const artifact of facts.artifacts) {
    const id = artifact.runId ? 'run:' + artifact.runId : 'issue:' + artifact.issueId
    const node = nodes.get(id); if (node) node.badges.artifacts++
  }
  for (const publication of facts.publications) { const node = nodes.get('run:' + publication.runId); if (node) node.badges.pullRequests++ }
  for (const check of facts.checks) { const node = check.candidateId && nodes.get('candidate:' + check.candidateId); if (node) node.badges.checks++ }
  // Terminal branch markers are facts about routes, not guesses from failed runs.
  for (const branch of branches.values()) if (branch.optionRef && ['abandoned', 'not_taken', 'completed'].includes(branch.status)) {
    const stop = branch.stoppedAtNodeId ? nodes.get(branch.stoppedAtNodeId) : undefined
    const fork = nodes.get(branch.forkNodeId!)!
    const node = addNode('end:' + branch.id, 'branch_end', branch.status, stop?.occurredAt ?? fork.occurredAt, 'unknown', branch.reason)
    node.branchId = branch.id; node.status = branch.status === 'abandoned' ? 'abandoned' : branch.status === 'completed' ? 'completed' : 'unknown'
    addEdge(stop?.id ?? fork.id, node.id, 'continues', 'declared')
  }
  if (nodes.size > MAP_NODE_LIMIT) throw new MapReadError('map_too_large', { detail: 'limit' })
  // Drop corrupt causal cycles rather than silently invent a lineage.
  const adjacency = new Map<string, string[]>()
  const orderedEdges: MapEdge[] = []
  function reachable(from: string, target: string) {
    const seen = new Set<string>(), stack = [from]
    while (stack.length) { const id = stack.pop()!; if (id === target) return true; if (seen.has(id)) continue; seen.add(id); stack.push(...(adjacency.get(id) ?? [])) }
    return false
  }
  for (const edge of [...edges.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (reachable(edge.to, edge.from)) { issues.push('lineage_cycle'); continue }
    orderedEdges.push(edge); adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
  }
  const hasParent = new Set(orderedEdges.map(edge => edge.to))
  for (const node of nodes.values()) if (node.id !== root && !hasParent.has(node.id))
    orderedEdges.push({ id: 'continues:' + root + ':' + node.id, from: root, to: node.id, kind: 'continues', evidence: 'host_verified' })
  const degree = new Map([...nodes.keys()].map(id => [id, 0]))
  const children = new Map<string, string[]>()
  for (const edge of orderedEdges) { degree.set(edge.to, degree.get(edge.to)! + 1); children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]) }
  const ready = [...nodes.values()].filter(node => degree.get(node.id) === 0).sort(byStableTime), sorted: MapNode[] = []
  while (ready.length) {
    const node = ready.shift()!; node.order = sorted.length; sorted.push(node)
    for (const child of children.get(node.id) ?? []) {
      degree.set(child, degree.get(child)! - 1)
      if (degree.get(child) === 0) { ready.push(nodes.get(child)!); ready.sort(byStableTime) }
    }
  }
  const dependencies: MapEdge[] = []
  for (const issue of facts.issues) for (const blockedBy of issue.blockedByIds ?? []) {
    if (!nodes.has('issue:' + blockedBy)) continue
    dependencies.push({ id: 'depends_on:issue:' + blockedBy + ':issue:' + issue.id, from: 'issue:' + blockedBy, to: 'issue:' + issue.id, kind: 'depends_on', evidence: 'host_verified' })
  }
  const dependencyChildren = new Map<string, string[]>()
  for (const edge of dependencies) dependencyChildren.set(edge.from, [...(dependencyChildren.get(edge.from) ?? []), edge.to])
  for (const start of dependencyChildren.keys()) {
    const seen = new Set<string>(), stack = [...(dependencyChildren.get(start) ?? [])]
    while (stack.length) { const id = stack.pop()!; if (id === start) { issues.push('dependency_cycle'); break }; if (seen.has(id)) continue; seen.add(id); stack.push(...(dependencyChildren.get(id) ?? [])) }
  }
  orderedEdges.push(...dependencies)
  if (orderedEdges.length > MAP_EDGE_LIMIT) throw new MapReadError('map_too_large', { detail: 'limit' })
  const mainline = new Set([main])
  for (const node of sorted) { const route = selected.get(node.id); if (route && mainline.has(node.branchId)) mainline.add(route) }
  let focus: MapGraph['focus'] = null
  let relevant = new Set(branches.keys())
  if (focusBranchId) {
    if (!branches.has(focusBranchId)) throw new MapReadError('map_not_found')
    relevant = new Set([focusBranchId])
    for (let pass = 0; pass < branches.size; pass++) for (const branch of branches.values())
      if (branch.parentBranchId && relevant.has(branch.parentBranchId)) relevant.add(branch.id)
    const breadcrumbs: { branchId: string; forkNodeId: string }[] = [], seen = new Set<string>()
    let current = branches.get(focusBranchId)!
    while (current.parentBranchId && current.forkNodeId && !seen.has(current.id)) {
      seen.add(current.id); breadcrumbs.unshift({ branchId: current.parentBranchId, forkNodeId: current.forkNodeId }); current = branches.get(current.parentBranchId)!
    }
    focus = { branchId: focusBranchId, breadcrumbs }
  }
  const laneByBranch = new Map<string, number | null>([[focusBranchId ?? main, 0]])
  const occupancy = new Map<number, string>([[0, focusBranchId ?? main]])
  const release = new Map<string, number>()
  for (const branch of branches.values()) {
    const ends = sorted.filter(node => node.branchId === branch.id)
    if (['abandoned', 'not_taken', 'completed'].includes(branch.status)) release.set(branch.id, ends.at(-1)?.order ?? nodes.get(branch.forkNodeId ?? root)?.order ?? 0)
  }
  const laneStates: MapGraph['laneStates'] = []
  for (const node of sorted) {
    for (const [lane, branch] of occupancy) if ((release.get(branch) ?? Infinity) < node.order) occupancy.delete(lane)
    if (!relevant.has(node.branchId)) { node.lane = null; laneStates.push({ order: node.order, occupied: [...occupancy].map(([lane, branchId]) => ({ lane, branchId })) }); continue }
    node.lane = laneByBranch.get(node.branchId) ?? null
    const options = [...branches.values()].filter(branch => branch.forkNodeId === node.id).sort((a, b) => a.id.localeCompare(b.id))
    const chosen = selected.get(node.id)
    if (chosen && relevant.has(chosen)) {
      laneByBranch.set(chosen, node.lane)
      if (node.lane !== null) occupancy.set(node.lane, chosen)
    }
    for (const option of options) if (option.id !== chosen && relevant.has(option.id)) {
      let lane: number | null = null
      if (node.lane !== null) for (let candidate = node.lane + 1; candidate < laneLimit; candidate++) if (!occupancy.has(candidate)) { lane = candidate; break }
      laneByBranch.set(option.id, lane)
      if (lane !== null) occupancy.set(lane, option.id)
    }
    for (const [lane, branch] of occupancy) if ((release.get(branch) ?? Infinity) <= node.order) occupancy.delete(lane)
    laneStates.push({ order: node.order, occupied: [...occupancy].map(([lane, branchId]) => ({ lane, branchId })) })
  }
  const folds: MapFold[] = []
  for (const branch of branches.values()) if (relevant.has(branch.id) && laneByBranch.get(branch.id) === null && branch.forkNodeId) {
    const contents = sorted.filter(node => node.branchId === branch.id)
    let anchor = nodes.get(branch.forkNodeId)!
    const visited = new Set<string>()
    while (anchor.lane === null && !visited.has(anchor.id)) {
      visited.add(anchor.id)
      const parent = branches.get(anchor.branchId)
      if (!parent?.forkNodeId) break
      anchor = nodes.get(parent.forkNodeId)!
    }
    if (anchor.lane !== null) folds.push({ id: 'fold:' + hash([branch.id, 1]), parentBranchId: anchor.branchId,
      anchor: { nodeId: anchor.id, order: anchor.order, lane: anchor.lane }, branchIds: [branch.id],
      orderStart: contents[0]?.order ?? anchor.order, orderEnd: contents.at(-1)?.order ?? anchor.order,
      nodeCount: contents.length, expand: { branchId: branch.id } })
  }
  const searchText: Record<string, string> = {}
  for (const artifact of facts.artifacts) {
    const id = artifact.runId ? 'run:' + artifact.runId : 'issue:' + artifact.issueId
    searchText[id] = (searchText[id] ?? '') + ' ' + artifact.title
  }
  return { nodes: sorted, edges: orderedEdges, branches: [...branches.values()], mainlineBranchIds: [...mainline], folds, focus, laneStates, searchText,
    coverage: { decisions: !decisions.length ? 'none' : issues.length || facts.runs.some(run => !assignments.has('run:' + run.id)) ? 'partial' : 'recorded', issues: [...new Set(issues)] } }
}

export function matchingNodes(graph: MapGraph, query: Pick<MapQuery, 'q' | 'filter' | 'from' | 'to' | 'branchId'>) {
  const abandoned = new Set(graph.branches.filter(branch => ['abandoned', 'not_taken'].includes(branch.status)).map(branch => branch.id))
  const included = new Set<string>(query.branchId ? [query.branchId] : graph.branches.map(branch => branch.id))
  if (query.branchId) for (let pass = 0; pass < graph.branches.length; pass++) for (const branch of graph.branches)
    if (branch.parentBranchId && included.has(branch.parentBranchId)) included.add(branch.id)
  const needle = query.q.toLocaleLowerCase()
  return graph.nodes.filter(node => included.has(node.branchId)
    && (!query.from || node.occurredAt >= query.from) && (!query.to || node.occurredAt <= query.to)
    && (!needle || [node.title, node.result, node.decision?.reason, graph.searchText[node.id]].filter(Boolean).join(' ').toLocaleLowerCase().includes(needle))
    && (query.filter === 'all' || query.filter === 'mainline' && graph.mainlineBranchIds.includes(node.branchId)
      || query.filter === 'abandoned' && abandoned.has(node.branchId) || query.filter === 'with_artifacts' && node.badges.artifacts > 0))
}
export function graphPage(graph: MapGraph, query: MapQuery, afterOrder = -1) {
  const matched = matchingNodes(graph, query), visible = matched.filter(node => node.lane !== null && node.order > afterOrder)
  const nodes = visible.slice(0, query.limit), ids = new Set(nodes.map(node => node.id))
  const edges = graph.edges.filter(edge => ids.has(edge.from) || ids.has(edge.to))
  const boundaryIds = new Set(edges.flatMap(edge => [edge.from, edge.to]).filter(id => !ids.has(id)))
  const boundaryNodes = graph.nodes.filter(node => boundaryIds.has(node.id)).map(({ id, order, lane }) => ({ id, order, lane }))
  const laneState = (order: number) => graph.laneStates.findLast(state => state.order <= order)?.occupied ?? []
  const branchIds = new Set([...nodes.map(node => node.branchId), ...(graph.focus ? [graph.focus.branchId] : []), ...graph.folds.flatMap(fold => fold.branchIds)])
  for (const node of nodes) for (const branch of graph.branches) if (branch.forkNodeId === node.id) branchIds.add(branch.id)
  return { schemaVersion: 1 as const, coverage: graph.coverage, nodes, edges,
    branches: graph.branches.filter(branch => branchIds.has(branch.id)), mainlineBranchIds: graph.mainlineBranchIds,
    boundaryNodes, laneState: { before: laneState((nodes[0]?.order ?? afterOrder + 1) - 1), after: laneState(nodes.at(-1)?.order ?? afterOrder) },
    folds: graph.folds.map(fold => ({ ...fold, nodeCount: matched.filter(node => fold.branchIds.includes(node.branchId)).length })),
    focus: graph.focus, page: { hasMore: visible.length > nodes.length, matchedCount: matched.length }, lastOrder: nodes.at(-1)?.order ?? afterOrder }
}
export function graphPath(graph: MapGraph, target: string) {
  if (!graph.nodes.some(node => node.id === target)) throw new MapReadError('map_not_found')
  const ancestors = new Set([target]), stack = [target]
  while (stack.length) {
    const id = stack.pop()!
    for (const edge of graph.edges) if (edge.to === id && edge.kind !== 'depends_on' && !ancestors.has(edge.from)) { ancestors.add(edge.from); stack.push(edge.from) }
  }
  const nodes = graph.nodes.filter(node => ancestors.has(node.id))
  const primary: string[] = [target]
  let current = target
  while (true) {
    const parents = graph.edges.filter(edge => edge.to === current && edge.kind !== 'depends_on')
    const chosen = parents.filter(edge => graph.mainlineBranchIds.includes(graph.nodes.find(node => node.id === edge.from)!.branchId))
    const edge = parents.length === 1 ? parents[0] : chosen.length === 1 ? chosen[0] : null
    if (!edge) break
    primary.unshift(edge.from); current = edge.from
  }
  return { schemaVersion: 1 as const, targetNodeId: target, nodes: nodes.map(({ id, order, branchId, lane }) => ({ id, order, branchId, lane })),
    edges: graph.edges.filter(edge => ancestors.has(edge.from) && ancestors.has(edge.to) && edge.kind !== 'depends_on'),
    primaryPathNodeIds: primary, selectedOptions: nodes.flatMap(node => node.decision?.selectedOptionId ? [{ decisionId: node.decision.id, optionId: node.decision.selectedOptionId }] : []),
    expand: graph.branches.filter(branch => nodes.some(node => node.branchId === branch.id && node.lane === null) && branch.forkNodeId).map(branch => ({ branchId: branch.id, forkNodeId: branch.forkNodeId! })) }
}
export function graphOverview(graph: MapGraph, query: MapQuery) {
  const matched = matchingNodes(graph, query), count = graph.nodes.length, width = Math.max(1, Math.ceil(count / 100))
  const bins = []
  for (let start = 0; start < count; start += width) {
    const nodes = matched.filter(node => node.order >= start && node.order < start + width)
    bins.push({ fromOrder: start, toOrder: Math.min(count - 1, start + width - 1), nodeCount: nodes.length,
      branchIds: [...new Set(nodes.map(node => node.branchId))], hasAbandoned: nodes.some(node => node.status === 'abandoned'), hasArtifact: nodes.some(node => node.badges.artifacts > 0) })
  }
  const byId = new Map(graph.nodes.map(node => [node.id, node]))
  const times = graph.nodes.map(node => node.occurredAt).sort()
  return { schemaVersion: 1 as const, totalVisibleNodes: count, matchedCount: matched.length,
    range: count ? { fromOrder: 0, toOrder: count - 1, fromTime: times[0], toTime: times.at(-1)! } : null,
    bins, branches: graph.branches, mainlineBranchIds: graph.mainlineBranchIds,
    branchLinks: graph.edges.flatMap(edge => {
      const from = byId.get(edge.from)!, to = byId.get(edge.to)!
      return from.branchId !== to.branchId && edge.kind !== 'depends_on' ? [{ fromBranchId: from.branchId, toBranchId: to.branchId, atOrder: to.order, kind: edge.kind }] : []
    }), laneSegments: graph.branches.flatMap(branch => {
      const nodes = graph.nodes.filter(node => node.branchId === branch.id)
      return nodes.length ? [{ branchId: branch.id, fromOrder: nodes[0].order, toOrder: nodes.at(-1)!.order, lane: nodes[0].lane,
        foldId: graph.folds.find(fold => fold.branchIds.includes(branch.id))?.id ?? null }] : []
    }), folds: graph.folds }
}
