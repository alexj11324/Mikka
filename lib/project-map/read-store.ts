import 'server-only'
import type { PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { maskFor } from '@/lib/secrets/runtime'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { isPersonalWorkspace } from '@/lib/tokens/scope'
import { resolveProjectReadScope, type ProjectScope } from './scope'
import { sanitizeSourceText } from './sources'
import { MAP_NODE_LIMIT, MAP_SOURCE_LIMIT, MAP_METADATA_BYTES, MapReadError, type MapFacts, type SourceRef, type DecisionFact } from './read-contracts'
import { decisionOptionSchema, decisionSourceLocatorSchema } from './contracts'
import { currentSourceAccess } from './source-access'
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
  let remaining = MAP_METADATA_BYTES
  // Independent projections share one roundtrip on the same read-only snapshot.
  // Sum the entire batch in PostgreSQL before any projection crosses the connection;
  // subsequent batches still consume the same cumulative metadata byte budget.
  const readMany = async <T extends unknown[]>(statements: readonly string[], values: unknown[]) => {
    const names = statements.map((_, index) => `projection_${index}`)
    const { rows: [result] } = await database.query<{ bytes: number; rows: unknown[][] | null }>(`WITH
      ${statements.map((statement, index) => `${names[index]} AS MATERIALIZED (${statement})`).join(',\n')},
      measured AS (SELECT sum(bytes) AS bytes FROM (${names.map(name =>
        `SELECT COALESCE(sum(octet_length(to_jsonb(${name})::text)+2),0) AS bytes FROM ${name}`).join(' UNION ALL ')}) sizes)
      SELECT bytes,CASE WHEN bytes <= $${values.length + 1} THEN jsonb_build_array(${names.map(name =>
        `COALESCE((SELECT jsonb_agg(to_jsonb(${name})) FROM ${name}),'[]'::jsonb)`).join(',')}) ELSE NULL END AS rows FROM measured`, [...values, remaining])
    const bytes = Number(result?.bytes)
    if (!result || !Array.isArray(result.rows) || result.rows.length !== statements.length || result.rows.some(rows => !Array.isArray(rows))
      || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > remaining) throw new MapReadError('map_too_large', { detail: 'limit' })
    remaining -= bytes
    return result.rows as { [K in keyof T]: T[K][] }
  }
  const read = async <T>(statement: string, values: unknown[]) => ({ rows: (await readMany<[T]>([statement], values))[0] })
  const initial = await readMany<[MapFacts['issues'][number], MapFacts['runs'][number], NonNullable<MapFacts['factoryVersions']>[number]]>([
    `SELECT id,left(title,200) AS title,status,"createdAt", COALESCE(content->'attrs'->'mikka'->'blockedByIds',content->'attrs'->'orvilo'->'blockedByIds','[]'::jsonb) AS "blockedByIds" FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id LIMIT 101`,
    `SELECT r.id,r."issueId",r.status,CASE WHEN r.status IN ('succeeded','failed','stopped') THEN r.outcome ELSE NULL END AS outcome,r."createdAt",r."finishedAt",
      r."retryOf",r."continuesRunId",r."threadReplacedBy",COALESCE(r."agentDefinition"->>'harness',a.harness) AS harness,CASE WHEN r."userId"=$2 THEN COALESCE(r."agentDefinition"->>'model',r."agentDefinition"->'subscription'->>'modelId',r."agentDefinition"->'apiKey'->>'model') ELSE NULL END AS "modelId",r."userId"=$2 AS owned
    FROM agent_runs r JOIN agents a ON a.id=r."agentId"
    LEFT JOIN bots b ON b.id=r."botId" LEFT JOIN computer_run_bindings cb ON cb."runId"=r.id
    WHERE r."issueId"=ANY($1::uuid[]) AND (b."workspaceId" IS NULL OR b."workspaceId"=$3)
      AND (cb."workspaceId" IS NULL OR cb."workspaceId"=$3)
    ORDER BY r."createdAt",r.id LIMIT $4`,
    `SELECT t.id,t.revision,t.status,t.stage,t."candidateId" FROM factory_tasks t LEFT JOIN bots b ON b.id=t."botId"
    WHERE t."issueId"=ANY($1::uuid[]) AND t."userId"=$2 AND (t."botId" IS NULL OR b."workspaceId"=$3) ORDER BY t.id LIMIT $4`,
  ], [scope.issueIds, scope.userId, scope.workspaceId, MAP_NODE_LIMIT + 1])
  const issues = bounded(initial[0], 100), runs = bounded(initial[1]), factoryVersions = bounded(initial[2])
  const ownRuns = runs.filter(run => run.owned).map(run => run.id)
  type Publication = { runId: string; issueId: string; remoteKey: string; url: string | null }
  const related = await readMany<[MapFacts['candidates'][number], MapFacts['checks'][number], MapFacts['artifacts'][number], Publication, Omit<DecisionFact, 'sources'>]>([
    `SELECT c.id,c."taskId",t."issueId",c."runId",c.kind,c.sha,c."createdAt",
      EXISTS(SELECT 1 FROM factory_deliverable_acceptances a WHERE a."taskId"=c."taskId" AND a."candidateId"=c.id AND a."userId"=$2)
      OR EXISTS(SELECT 1 FROM factory_merges m WHERE m."taskId"=c."taskId" AND m."candidateId"=c.id AND m.status='merged') AS accepted
    FROM factory_candidates c JOIN factory_tasks t ON t.id=c."taskId"
    WHERE t."issueId"=ANY($1::uuid[]) AND t."userId"=$2 AND c."runId"=ANY($3::uuid[]) AND t.id=ANY($5::uuid[])
    ORDER BY c."createdAt",c.id LIMIT $4`,
    `SELECT a.id,a."taskId",t."issueId",a."candidateId",a."runId",a.stage,a.status,
      left(a.reason,4000) AS reason,a."createdAt",a."finishedAt"
    FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
    WHERE t."issueId"=ANY($1::uuid[]) AND t."userId"=$2 AND a.stage IN ('review','verify')
      AND (a."runId" IS NULL OR a."runId"=ANY($3::uuid[])) AND t.id=ANY($5::uuid[])
    ORDER BY a."createdAt",a.id LIMIT $4`,
    `SELECT a.id,v.id AS "versionId",v.version,a.kind,v."createdAt",
      left(COALESCE(NULLIF(e.payload->>'title',''),a.title),500) AS title,
      CASE WHEN e.id IS NULL THEN a."issueId" ELSE e."issueId" END AS "issueId",
      CASE WHEN e.id IS NULL THEN a."runId" ELSE e."runId" END AS "runId"
    FROM artifacts a JOIN artifact_versions v ON v."artifactId"=a.id
    LEFT JOIN coordinator_events e ON e."dedupeKey"='artifact_submitted:'||a.id::text||':'||v.version::text
    WHERE a."userId"=$2
      AND ((e.id IS NULL AND v.version=1) OR (e.kind='artifact_submitted' AND e."userId"=a."userId"
        AND e.payload->>'artifactId'=a.id::text AND jsonb_typeof(e.payload->'version')='number' AND e.payload->>'version'=v.version::text))
      AND (CASE WHEN e.id IS NULL THEN a."issueId" ELSE e."issueId" END)=ANY($1::uuid[])
      AND ((CASE WHEN e.id IS NULL THEN a."runId" ELSE e."runId" END) IS NULL
        OR (CASE WHEN e.id IS NULL THEN a."runId" ELSE e."runId" END)=ANY($3::uuid[]))
    ORDER BY v."createdAt",v.id LIMIT $4`,
    `SELECT "runId","issueId","remoteKey","pullRequest"->>'url' AS url
    FROM run_publications WHERE "runId"=ANY($3::uuid[]) AND "userId"=$2 ORDER BY "runId" LIMIT $4`,
    `SELECT id,"issueId","factoryTaskId","runId",kind,title,summary,reason,options,
      "selectedOptionId","contextOptionRef","predecessorDecisionIds",provenance,"captureMode","decidedBy","recordedBy",
      "occurredAt","recordedAt","supersedesId","recordStatus"
    FROM project_decisions WHERE "projectId"=$6 AND "workspaceId"=$7 AND "ownerId"=$2
      AND ("issueId" IS NULL OR "issueId"=ANY($1::uuid[]))
      AND ("runId" IS NULL OR "runId"=ANY($3::uuid[]))
      AND ("factoryTaskId" IS NULL OR "factoryTaskId"=ANY($5::uuid[]))
    ORDER BY "recordedAt",id LIMIT $4`,
  ], [scope.issueIds, scope.userId, ownRuns, MAP_NODE_LIMIT + 1, factoryVersions.map(task => task.id), scope.projectId, scope.workspaceId])
  const candidates = bounded(related[0]), checks = bounded(related[1]), artifacts = bounded(related[2]), decisions = bounded(related[4])
  const publications = bounded(related[3]).flatMap(row => {
    if (typeof row.url !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*\/?$/.test(row.url)) return []
    const parts = new URL(row.url).pathname.split('/'), repositoryKey = parts.slice(1, 3).join('/').toLowerCase()
    const remote = String(row.remoteKey).replace(/^https:\/\/github\.com\//, '').replace(/^git@github\.com:/, '').replace(/\.git$/, '').toLowerCase()
    if (remote !== repositoryKey) return []
    return [{ runId: row.runId, issueId: row.issueId, repositoryKey, number: Number(parts[4]), url: row.url, commitSha: null }]
  })
  const sources = decisions.length ? bounded((await read<{ id: string; decisionId: string; role: string; optionId: string | null; relation: SourceRef['relation']; locator: unknown }>(`SELECT id,"decisionId",role,"optionId",relation,locator
    FROM project_decision_sources WHERE "decisionId"=ANY($1::uuid[]) AND "ownerId"=$2 AND "workspaceId"=$3 ORDER BY id LIMIT $4`,
    [decisions.map(decision => decision.id), scope.userId, scope.workspaceId, MAP_SOURCE_LIMIT + 1])).rows, MAP_SOURCE_LIMIT) : []
  const access = await currentSourceAccess({ query: read } as Database, scope, sources.map(source => source.id), ownRuns, personal)
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
  return maskFor({ workspaceId: scope.workspaceId, ownerId: scope.userId }, facts)
}
function scopeVersion(scope: ProjectScope) {
  return JSON.stringify([scope.project.userId, scope.project.revision, [...scope.issueIds].sort(), scope.workspaceId, scope.personalWorkspace])
}
/** The app DB snapshot is short and read-only; workspace ACL is rechecked afterwards. */
export async function readMapFacts(scope: ProjectScope) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const personal = scope.personalWorkspace ?? await isPersonalWorkspace(scope.userId, scope.workspaceId)
    const client = await pool.connect()
    let facts: MapFacts
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      facts = await collectMapFacts(client, scope, personal)
      await client.query('COMMIT')
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {})
      if (cause instanceof MapReadError) throw cause
      throw new MapReadError('map_unavailable', { detail: 'database', cause })
    } finally { client.release() }
    const current = await resolveProjectReadScope({ id: scope.userId, [tokenWorkspace]: scope.workspaceId }, scope.projectId, scope.workspaceId)
    if (scopeVersion(scope) === scopeVersion(current)) return facts
    scope = current
  }
  throw new MapReadError('map_snapshot_changed', { detail: 'source_changed' })
}
