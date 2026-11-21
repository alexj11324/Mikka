import 'server-only'
import type { PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { maskProjectMapFacts } from '@/lib/secrets/project-map-mask'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { isPersonalWorkspace } from '@/lib/tokens/scope'
import { resolveProjectReadScope, type ProjectScope } from './scope'
import { sanitizeSourceText } from './sources'
import { MAP_NODE_LIMIT, MAP_SOURCE_LIMIT, MAP_METADATA_BYTES, MapReadError, type MapFacts, type SourceRef, type DecisionFact } from './read-contracts'
import { decisionOptionSchema, decisionSourceLocatorSchema } from './contracts'
import { mapFactsSql } from './read-sql'
import { decodeMapRows } from './read-transport'
import { z } from 'zod'
import { harnessSchema } from '@mikka/protocol/harness'

type Database = Pick<PoolClient, 'query'>
const iso = (date: unknown) => date instanceof Date ? date.toISOString() : new Date(String(date)).toISOString()
const bounded = <T>(rows: T[], max = MAP_NODE_LIMIT): T[] => {
  if (rows.length > max) throw new MapReadError('map_too_large', { detail: 'limit' })
  return rows
}

/** No transcript, report, prompt, credential, environment or execution definition enters the graph read. */
export async function collectMapFacts(database: Database, scope: ProjectScope, personal = false): Promise<MapFacts> {
  type Publication = { runId: string; issueId: string; remoteKey: string; url: string | null }
  type Source = { id: string; decisionId: string; role: string; optionId: string | null; relation: SourceRef['relation']; locator: unknown }
  type Projections = [unknown, unknown, NonNullable<MapFacts['factoryVersions']>, MapFacts['candidates'],
    MapFacts['checks'], MapFacts['artifacts'], Publication[], Omit<DecisionFact, 'sources'>[], Source[], { id: string; availability: string | null }[]]
  const { rows: [result] } = await database.query<{ bytes: number; rows: Projections | null }>(mapFactsSql(),
    [scope.issueIds, scope.userId, scope.workspaceId, MAP_NODE_LIMIT + 1, MAP_SOURCE_LIMIT + 1, personal, scope.projectId, MAP_METADATA_BYTES])
  const bytes = Number(result?.bytes)
  if (!result || !Array.isArray(result.rows) || result.rows.length !== 10 || result.rows.slice(2).some(rows => !Array.isArray(rows))
    || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAP_METADATA_BYTES) throw new MapReadError('map_too_large', { detail: 'limit' })
  const related = result.rows.slice(3, 8) as [MapFacts['candidates'], MapFacts['checks'], MapFacts['artifacts'], Publication[], Omit<DecisionFact, 'sources'>[]]
  const issues = decodeMapRows<MapFacts['issues'][number]>(result.rows[0], 'issues', scope.issueIds, MAP_NODE_LIMIT)
  const runs = decodeMapRows<MapFacts['runs'][number]>(result.rows[1], 'runs', scope.issueIds, MAP_NODE_LIMIT)
  const factoryVersions = bounded(result.rows[2])
  const candidates = bounded(related[0]), checks = bounded(related[1]), artifacts = bounded(related[2]), decisions = bounded(related[4])
  const publications = bounded(related[3]).flatMap(row => {
    if (typeof row.url !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/.test(row.url)) return []
    const parts = new URL(row.url).pathname.split('/'), repositoryKey = parts.slice(1, 3).join('/').toLowerCase()
    const remote = String(row.remoteKey).replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '').toLowerCase()
    if (remote !== repositoryKey) return []
    return [{ runId: row.runId, issueId: row.issueId, repositoryKey, number: Number(parts[4]), url: row.url, commitSha: null }]
  })
  const sources = bounded(result.rows[8], MAP_SOURCE_LIMIT)
  const access = new Map(result.rows[9].filter(row => row.availability).map(row => [row.id, row.availability!]))
  const byDecision = new Map<string, typeof sources>()
  for (const source of sources) byDecision.set(source.decisionId, [...(byDecision.get(source.decisionId) ?? []), source])
  const readable: DecisionFact[] = []
  for (const row of decisions) {
    const references: SourceRef[] = []
    let hidden = false
    for (const source of byDecision.get(row.id) ?? []) {
      const availability = access.get(source.id), parsed = decisionSourceLocatorSchema.safeParse(source.locator)
      if (!availability || !parsed.success) { hidden = true; break }
      references.push({ sourceRef: source.id, role: source.role, optionId: source.optionId, relation: source.relation,
        availability: availability === 'unavailable' ? 'unavailable' : 'available', locator: availability === 'unavailable' ? null : parsed.data })
    }
    if (hidden) continue
    const options = z.array(decisionOptionSchema).max(20).safeParse(row.options)
    if (!options.success) throw new MapReadError('map_unavailable', { detail: 'database', cause: options.error })
    readable.push({ ...row, title: sanitizeSourceText(row.title), summary: sanitizeSourceText(row.summary), reason: sanitizeSourceText(row.reason),
      options: options.data.map(option => ({ ...option, title: sanitizeSourceText(option.title), reason: option.reason === null ? null : sanitizeSourceText(option.reason) })), occurredAt: iso(row.occurredAt), recordedAt: iso(row.recordedAt), sources: references })
  }
  const facts: MapFacts = {
    project: { id: scope.projectId, title: sanitizeSourceText(scope.project.name), revision: scope.project.revision, createdAt: iso(scope.project.createdAt) },
    issues: issues.map(row => ({ ...row, title: sanitizeSourceText(row.title), createdAt: iso(row.createdAt), blockedByIds: z.array(z.uuid()).max(100).catch([]).parse(row.blockedByIds) })),
    runs: runs.map(row => ({ ...row, harness: harnessSchema.nullable().catch(null).parse(row.harness), createdAt: iso(row.createdAt), finishedAt: row.finishedAt ? iso(row.finishedAt) : null })),
    candidates: candidates.map(row => ({ ...row, sha: typeof row.sha === 'string' && /^[a-f0-9]{40}$/.test(row.sha) ? row.sha : null, createdAt: iso(row.createdAt) })),
    checks: checks.map(row => ({ ...row, reason: typeof row.reason === 'string' ? sanitizeSourceText(row.reason) : null, createdAt: iso(row.createdAt), finishedAt: row.finishedAt ? iso(row.finishedAt) : null })),
    artifacts: artifacts.map(row => ({ ...row, title: sanitizeSourceText(row.title), createdAt: iso(row.createdAt) })),
    factoryVersions, publications, decisions: readable,
  }
  return maskProjectMapFacts({ workspaceId: scope.workspaceId, ownerId: scope.userId }, facts)
}
function scopeVersion(scope: ProjectScope) {
  return JSON.stringify([scope.project.userId, scope.project.revision, [...scope.issueIds].sort(), scope.workspaceId, scope.personalWorkspace])
}
/** Every collector is one read-only snapshot; recheck both authority databases afterwards. */
export async function readMapFacts(scope: ProjectScope) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const personal = scope.personalWorkspace ?? await isPersonalWorkspace(scope.userId, scope.workspaceId)
    let facts: MapFacts
    try { facts = await collectMapFacts(pool, scope, personal) }
    catch (cause) {
      if (cause instanceof MapReadError) throw cause
      throw new MapReadError('map_unavailable', { detail: 'database', cause })
    }
    const current = await resolveProjectReadScope({ id: scope.userId, [tokenWorkspace]: scope.workspaceId }, scope.projectId, scope.workspaceId)
    if (scopeVersion(scope) === scopeVersion(current)) return facts
    scope = current
  }
  throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
}
