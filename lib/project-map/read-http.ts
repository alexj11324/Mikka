import 'server-only'
import { z } from 'zod'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { withBasePath } from '../base-path'
import { auth, apiWorkspaceAllowed } from '@/lib/api-auth'
import { logCodedError } from '@mikka/protocol/coded-error'
import { ProjectMapError } from './contracts'
import { resolveProjectReadScope } from './scope'
import { readMapFacts } from './read-store'
import { checkSnapshot, fingerprint, readMapToken, signMapToken, snapshotClaims, type MapClaims } from './cursor'
import { graphOverview, graphPage, graphPath, projectGraph } from './graph'
import { mapQuerySchema, MapReadError, type MapFacts, type MapGraph, type MapQuery } from './read-contracts'
import { mapSourceHttp } from './source-read'
import { readRevisions } from '@/lib/live/revision-read'
import { mapReadReply } from './read-response'

const reply = mapReadReply
export type MapOperation = 'page' | 'node' | 'path' | 'overview' | 'source'
export async function projectMapHttp(request: Request, projectId: string, operation: MapOperation, target?: string): Promise<Response> {
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session) throw new MapReadError('map_auth_required')
    if (!z.uuid().safeParse(projectId).success) throw new MapReadError('map_not_found')
    const url = new URL(request.url), raw: Record<string, string> = {}
    for (const [key, value] of url.searchParams) {
      if (Object.hasOwn(raw, key)) throw new MapReadError('map_invalid_request', { detail: 'invalid_query' })
      raw[key] = value
    }
    const workspace = z.uuid().safeParse(raw.workspaceId)
    if (!workspace.success) throw new MapReadError('map_invalid_request', { detail: 'invalid_query', cause: workspace.error })
    if (!apiWorkspaceAllowed(session, workspace.data)) throw new MapReadError('map_not_found')
    const scope = await resolveProjectReadScope(session.user, projectId, workspace.data)
    // Read the committed revision before any content it describes. This is the
    // selected, authorized workspace channel used by projectMapTargets.
    const live = { ownerId: scope.userId, workspaceId: scope.workspaceId,
      revisions: await readRevisions([{ kind: 'project_map', id: projectId }]) }
    if (operation === 'source') {
      const response = await mapSourceHttp(request, scope, target ?? '', raw, live)
      const current = await resolveProjectReadScope(session.user, projectId, workspace.data)
      if (scope.project.userId !== current.project.userId || scope.project.revision !== current.project.revision
        || scope.personalWorkspace !== current.personalWorkspace
        || [...scope.issueIds].sort().join(',') !== [...current.issueIds].sort().join(','))
        throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
      return response
    }
    const { nodeId, ...queryInput } = raw
    if (nodeId !== undefined && operation !== 'path') throw new MapReadError('map_invalid_request', { detail: 'invalid_query' })
    const parsed = mapQuerySchema.safeParse(queryInput)
    if (!parsed.success) throw new MapReadError('map_invalid_request', { detail: 'invalid_query', cause: parsed.error })
    let query = parsed.data
    let claims: MapClaims | undefined
    if (operation === 'page') {
      if (query.snapshot) throw new MapReadError('map_invalid_request', { detail: 'invalid_query' })
      if (query.cursor) claims = readMapToken(query.cursor, scope, ['page'])
    } else {
      if (!query.snapshot || query.cursor) throw new MapReadError('map_invalid_request', { detail: 'invalid_query' })
      claims = readMapToken(query.snapshot, scope, ['snapshot'])
      const supplied = ['laneLimit', 'branchId', 'q', 'filter', 'from', 'to'] as const
      for (const key of supplied) if (Object.hasOwn(raw, key) && query[key] !== claims.query[key])
        throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
      query = { ...query, ...claims.query }
    }
    const facts = await readMapFacts(scope), content = fingerprint(facts)
    if (claims) checkSnapshot(claims, content, query)
    else claims = snapshotClaims(scope, query, content)
    const snapshot = { id: signMapToken({ ...claims, kind: 'snapshot', afterOrder: undefined, afterId: undefined }), expiresAt: new Date(claims.expiresAt).toISOString(), layoutVersion: 1 }
    const graph = projectGraph(facts, query.laneLimit as 2 | 3, query.branchId)
    if (operation === 'page') {
      const page = graphPage(graph, query, claims.afterOrder ?? -1)
      if (claims.afterOrder !== undefined && !graph.nodes.some(node => node.order === claims!.afterOrder && node.id === claims!.afterId))
        throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
      const { lastOrder, ...result } = page
      return reply({ ...result, snapshot, live, page: { ...page.page, nextCursor: page.page.hasMore
        ? signMapToken({ ...claims, kind: 'page', afterOrder: lastOrder, afterId: page.nodes.at(-1)!.id }) : null } })
    }
    if (operation === 'path') return reply({ ...graphPath(graph, nodeId ?? ''), snapshotId: snapshot.id, live })
    if (operation === 'overview') return reply({ ...graphOverview(graph, query), snapshotId: snapshot.id, live })
    return reply({ ...nodeDetail(facts, graph, target ?? '', query), snapshotId: snapshot.id, live })
  } catch (cause) {
    const error = cause instanceof MapReadError ? cause
      : cause instanceof ProjectMapError && cause.status === 404 ? new MapReadError('map_not_found', { cause })
      : cause instanceof ProjectMapError && cause.status === 409 ? new MapReadError('map_scope_conflict', { cause })
      : cause instanceof ProjectMapError && cause.status === 400 ? new MapReadError('map_invalid_request', { detail: 'invalid_query', cause })
      : new MapReadError('map_unavailable', { detail: 'database', cause })
    logCodedError(error, { operation })
    return reply({ error: error.code.toUpperCase(), code: error.code, ...(error.detail ? { detail: error.detail } : {}),
      ...(error.code === 'map_snapshot_changed' ? { restart: true } : {}) }, error.status)
  }
}

function nodeDetail(facts: MapFacts, graph: MapGraph, target: string, _query: MapQuery) {
  const node = graph.nodes.find(node => node.id === target)
  if (!node) throw new MapReadError('map_not_found')
  const run = facts.runs.find(run => 'run:' + run.id === target)
  const candidate = facts.candidates.find(candidate => 'candidate:' + candidate.id === target)
  const branch = node.type === 'branch_end' ? graph.branches.find(branch => branch.id === node.branchId) : undefined
  const decision = facts.decisions.find(decision => 'decision:' + decision.id === target || decision.id === branch?.optionRef?.decisionId)
  const issueId = run?.issueId ?? candidate?.issueId ?? decision?.issueId ?? (node.type === 'task' ? target.slice(6) : null)
  const taskIds = new Set(facts.issues.filter(issue => node.type === 'project' || issue.id === issueId).map(issue => issue.id))
  const sourceRuns = (value: MapFacts['decisions'][number]) => value.sources.flatMap(source => {
    const locator = source.availability === 'available' ? source.locator : null
    return locator?.runId ? [locator.runId] : locator?.type === 'run' ? [locator.id] : []
  })
  const branchDecisions = branch?.optionRef ? facts.decisions.filter(value => value.id === decision?.id
    || value.contextOptionRef?.decisionId === branch.optionRef!.decisionId && value.contextOptionRef.optionId === branch.optionRef!.optionId) : []
  const container = node.type === 'project' || node.type === 'task'
  const runIds = new Set(container ? facts.runs.filter(run => taskIds.has(run.issueId)).map(run => run.id)
    : run ? [run.id] : candidate ? [candidate.runId]
      : [...(decision?.runId ? [decision.runId] : []), ...(decision ? sourceRuns(decision) : []), ...branchDecisions.flatMap(sourceRuns)])
  const related = (value: MapFacts['decisions'][number]) => value.id === decision?.id || branchDecisions.includes(value)
    || node.type === 'project' || node.type === 'task' && value.issueId !== null && taskIds.has(value.issueId)
    || value.runId !== null && runIds.has(value.runId) || sourceRuns(value).some(id => runIds.has(id))
  const decisions = facts.decisions.filter(related)
  const chosenCandidates = new Set(candidate ? [candidate.id] : facts.candidates.filter(value => runIds.has(value.runId)).map(value => value.id))
  const rootRun = (id: string) => {
    const visited = new Set<string>()
    while (!visited.has(id)) {
      visited.add(id)
      const current = facts.runs.find(run => run.id === id), previous = current?.continuesRunId ?? current?.retryOf
      if (!previous || !facts.runs.some(run => run.id === previous && run.owned)) break
      id = previous
    }
    return id
  }
  const sourceRefs = [...new Set(decisions.flatMap(value => value.sources.map(source => 'source:' + source.sourceRef)))]
  const ownedRuns = facts.runs.filter(run => run.owned && runIds.has(run.id))
  const decisionItems = decisions.map(value => ({
    id: value.id, kind: value.kind, title: value.title, summary: value.summary, reason: value.reason,
    options: value.options, selectedOptionId: value.selectedOptionId, contextOptionRef: value.contextOptionRef,
    predecessorDecisionIds: value.predecessorDecisionIds, provenance: value.provenance, captureMode: value.captureMode,
    occurredAt: value.occurredAt, recordedAt: value.recordedAt, supersedesId: value.supersedesId, recordStatus: value.recordStatus,
    sourceRefs: value.sources.map(source => 'source:' + source.sourceRef),
  }))
  return {
    schemaVersion: 1 as const, node, sections: [
      { kind: 'tasks', items: facts.issues.filter(issue => taskIds.has(issue.id)).map(issue =>
        ({ id: issue.id, title: issue.title, status: issue.status, href: withBasePath(workspaceLink({ issue: issue.id })) })) },
      { kind: 'decisions', items: decisionItems },
      { kind: 'artifacts', items: facts.artifacts.filter(artifact => artifact.runId ? runIds.has(artifact.runId) : container && taskIds.has(artifact.issueId)).map(artifact =>
        ({ id: artifact.id, versionId: artifact.versionId, title: artifact.title, mediaType: artifact.kind === 'html' ? 'text/html' : 'text/markdown',
          href: '/mikka/api/artifacts/' + artifact.id + '/versions/' + artifact.version + '/download' })) },
      { kind: 'checks', items: facts.checks.filter(check => check.candidateId && chosenCandidates.has(check.candidateId)).map(check =>
        ({ attemptId: check.id, candidateId: check.candidateId, runId: check.runId, stage: check.stage, status: check.status, reason: check.reason, checkedAt: check.finishedAt,
          sourceRefs: [...new Set([...facts.decisions.flatMap(value => value.sources.filter(source => source.locator?.type === 'attempt' && source.locator.id === check.id)
            .map(source => 'source:' + source.sourceRef)), ...(check.runId && ownedRuns.some(run => run.id === check.runId) ? ['run:' + check.runId] : [])])] })) },
      { kind: 'conversation_summary', items: decisions.map(value =>
        ({ text: value.summary, provenance: value.provenance, sourceRefs: value.sources.map(source => 'source:' + source.sourceRef) })) },
      { kind: 'threads', items: ownedRuns.map(run =>
        ({ rootRunId: rootRun(run.id), harness: run.harness, status: run.status, href: withBasePath(workspaceLink({ issue: run.issueId, thread: run.id })) })) },
    ],
    references: {
      runs: ownedRuns.map(run => ({ id: run.id, rootRunId: rootRun(run.id), href: withBasePath(workspaceLink({ issue: run.issueId, thread: run.id })) })),
      pullRequests: facts.publications.filter(publication => runIds.has(publication.runId))
        .map(({ repositoryKey, number, url, commitSha }) => ({ repositoryKey, number, url, commitSha })),
      sources: [...sourceRefs, ...ownedRuns.map(run => 'run:' + run.id)],
    },
  }
}
