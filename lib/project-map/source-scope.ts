import 'server-only'
import { z } from 'zod'
import { pool } from '@/lib/db'
import { isPersonalWorkspace, runsOutsideToken } from '@/lib/tokens/scope'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { decisionSourceLocatorSchema, type DecisionSourceLocator } from './contracts'
import type { ProjectScope } from './scope'
import { currentSourceAccess } from './source-access'
import { MapReadError } from './read-contracts'

type Stored = { id: string; sourceType: string; sourceId: string; locator: unknown; decisionRunId: string | null }
type Handle = { availability: 'available'; locator: DecisionSourceLocator } | { availability: 'unavailable'; locator: null }
const missing = (): never => { throw new MapReadError('map_not_found') }

/** One owned execution in a currently visible project task; no prompt/report or
 * task body is needed to authorize the lazy chunk stream. */
export async function currentMapRun(scope: ProjectScope, locator: DecisionSourceLocator): Promise<DecisionSourceLocator> {
  const { rows: [run] } = await pool.query<{ id: string; issueId: string; botId: string | null; sessionId: string | null }>(
    `SELECT id,"issueId","botId",CASE WHEN octet_length("sessionId")<=200 THEN "sessionId" ELSE NULL END AS "sessionId"
     FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "issueId"=ANY($3::uuid[]) LIMIT 1`,
    [locator.id, scope.userId, scope.issueIds])
  if (!run || (await runsOutsideToken({ id: scope.userId, [tokenWorkspace]: scope.workspaceId }, [run.id])).has(run.id)) return missing()
  const actual: DecisionSourceLocator = { type: 'run', id: run.id, runId: run.id, issueId: run.issueId,
    botId: run.botId, ...(run.sessionId ? { sessionId: run.sessionId } : {}) }
  for (const key of Object.keys(locator) as (keyof DecisionSourceLocator)[]) if (locator[key] !== actual[key]) return missing()
  return { type: 'run', id: run.id, runId: run.id, issueId: run.issueId }
}

/** sourceRef is only a locator. Recheck its owner, workspace, project, task and
 * every source of the containing decision, without rereading unrelated runs. */
export async function resolveMapSource(scope: ProjectScope, sourceRef: string): Promise<Handle> {
  if (sourceRef.startsWith('run:') && z.uuid().safeParse(sourceRef.slice(4)).success)
    return { availability: 'available', locator: await currentMapRun(scope, { type: 'run', id: sourceRef.slice(4) }) }
  if (!sourceRef.startsWith('source:') || !z.uuid().safeParse(sourceRef.slice(7)).success) return missing()
  const { rows: [measured] } = await pool.query<{ rows: Stored[] | null }>(`WITH chosen AS (
      SELECT d.id,d."runId" FROM project_decisions d
      JOIN project_decision_sources requested ON requested."decisionId"=d.id
      WHERE requested.id=$1 AND requested."ownerId"=$2 AND requested."workspaceId"=$3
        AND d."ownerId"=$2 AND d."workspaceId"=$3 AND d."projectId"=$4
        AND (d."issueId" IS NULL OR d."issueId"=ANY($5::uuid[]))
        AND (d."factoryTaskId" IS NULL OR EXISTS(SELECT 1 FROM factory_tasks t
          LEFT JOIN bots b ON b.id=t."botId" AND b."ownerId"=t."userId"
          WHERE t.id=d."factoryTaskId" AND t."userId"=$2 AND t."issueId"=ANY($5::uuid[])
            AND (t."botId" IS NULL OR b."workspaceId"=$3))) LIMIT 1
    ), refs AS MATERIALIZED (
      SELECT s.id,s."sourceType",s."sourceId",s.locator,c."runId" AS "decisionRunId"
      FROM chosen c JOIN project_decision_sources s ON s."decisionId"=c.id
      WHERE s."ownerId"=$2 AND s."workspaceId"=$3 ORDER BY s.id LIMIT 51
    ), budget AS (SELECT COALESCE(sum(octet_length(to_jsonb(refs)::text)+2),0) AS bytes FROM refs)
    SELECT CASE WHEN bytes<=65536 THEN COALESCE((SELECT jsonb_agg(to_jsonb(refs)) FROM refs),'[]'::jsonb) ELSE NULL END AS rows FROM budget`,
    [sourceRef.slice(7), scope.userId, scope.workspaceId, scope.projectId, scope.issueIds])
  if (!measured || !Array.isArray(measured.rows) || measured.rows.length > 50) throw new MapReadError('map_source_too_large', { detail: 'limit' })
  const references = measured.rows
  if (!references.length) return missing()
  const parsed = references.map(row => decisionSourceLocatorSchema.safeParse(row.locator))
  if (parsed.some((value, index) => !value.success || value.data.type !== references[index].sourceType || value.data.id !== references[index].sourceId)) return missing()
  const locators = parsed.map(value => value.data!)
  const required = [...new Set([...references.flatMap(row => row.decisionRunId ? [row.decisionRunId] : []),
    ...locators.flatMap(locator => locator.runId ? [locator.runId] : ['run', 'pull_request'].includes(locator.type) ? [locator.id] : [])])]
    .filter(id => z.uuid().safeParse(id).success)
  const { rows } = required.length ? await pool.query<{ id: string }>(
    'SELECT id FROM agent_runs WHERE id=ANY($1::uuid[]) AND "userId"=$2 AND "issueId"=ANY($3::uuid[]) ORDER BY id LIMIT 51',
    [required, scope.userId, scope.issueIds]) : { rows: [] }
  const excluded = await runsOutsideToken({ id: scope.userId, [tokenWorkspace]: scope.workspaceId }, rows.map(row => row.id))
  const owned = rows.map(row => row.id).filter(id => !excluded.has(id))
  if (references[0].decisionRunId && !owned.includes(references[0].decisionRunId)) return missing()
  const access = await currentSourceAccess(pool, scope, references.map(row => row.id), owned, await isPersonalWorkspace(scope.userId, scope.workspaceId))
  if (references.some(row => !access.has(row.id))) return missing()
  const index = references.findIndex(row => row.id === sourceRef.slice(7))
  if (index < 0) return missing()
  if (access.get(references[index].id) === 'unavailable') return { availability: 'unavailable', locator: null }
  return { availability: 'available', locator: locators[index].type === 'run' ? await currentMapRun(scope, locators[index]) : locators[index] }
}
