import 'server-only'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { effectiveRequestWorkspace, type RequestWorkspaceUser } from '@/lib/request-workspace'

/** An API session user; a personal access token pins it to one workspace. */
type ApiUser = RequestWorkspaceUser

// Request workspace scope only narrows ordinary ACL. Task, thread and artifact
// tenants are persisted; unresolved historical records grant no request access.

type Scope = { workspaceId: string; personal: () => Promise<boolean> }

/** Whether this workspace is the user's own personal workspace. */
export async function isPersonalWorkspace(userId: string, workspaceId: string) {
  const result = await workspacePool.query(`SELECT 1 FROM mikka_workspaces WHERE id=$1 AND "userId"=$2 AND kind='personal'`, [workspaceId, userId])
  return Boolean(result.rowCount)
}

function tokenScope(user: ApiUser): Scope | null {
  const workspaceId = user[tokenWorkspace]
  if (!workspaceId) return null
  let personal: Promise<boolean> | undefined
  return {
    workspaceId,
    personal: () => personal ??= isPersonalWorkspace(user.id, workspaceId),
  }
}

/** Whether a record whose links name these workspaces (nulls: no link) is outside the token's workspace. */
async function outside(scope: Scope, named: readonly (string | null | undefined)[]) {
  const workspaces = named.filter((id): id is string => Boolean(id))
  return workspaces.length ? workspaces.some(id => id !== scope.workspaceId) : !await scope.personal()
}

/** Thread tenant is immutable even after its source links are removed. */
export async function runsOutsideToken(user: ApiUser, runIds: readonly string[]): Promise<Set<string>> {
  if (!runIds.length) return new Set()
  return runsOutsideWorkspace(await effectiveRequestWorkspace(user), runIds)
}

async function runsOutsideWorkspace(workspaceId: string | null, runIds: readonly string[]): Promise<Set<string>> {
  const result = new Set(runIds)
  if (!result.size) return result
  if (!workspaceId) return result
  const { rows } = await pool.query<{ id: string; workspaceId: string | null }>('SELECT id,"workspaceId" FROM agent_runs WHERE id=ANY($1::uuid[])', [runIds])
  for (const row of rows) {
    if (row.workspaceId === workspaceId) result.delete(row.id)
  }
  return result
}

export async function runOutsideToken(user: ApiUser, runId: string) {
  return (await runsOutsideToken(user, [runId])).has(runId)
}

// The runs a self-improvement record was made from.
const improvementSourceRuns = {
  proposal: `SELECT s."runId",i."workspaceId",i."ownershipState" FROM improvement_proposals p
    LEFT JOIN improvement_proposal_sources s ON s."proposalId"=p.id LEFT JOIN issues i ON i.id=p."issueId" WHERE p.id=$1`,
  instance: `SELECT b."sourceRunId" AS "runId",i."workspaceId",i."ownershipState" FROM improvement_benchmark_instances b
    LEFT JOIN issues i ON i.id=b."issueId" WHERE b.id=$1`,
  evaluation: `SELECT b."sourceRunId" AS "runId",i."workspaceId",i."ownershipState" FROM improvement_skill_evaluations e
    JOIN improvement_benchmark_instances b ON b.id=e."instanceId" LEFT JOIN issues i ON i.id=b."issueId" WHERE e.id=$1
    UNION ALL SELECT s."runId",i."workspaceId",i."ownershipState" FROM improvement_skill_evaluations e
    LEFT JOIN improvement_proposals p ON p.id=e."proposalId" LEFT JOIN improvement_proposal_sources s ON s."proposalId"=p.id
    LEFT JOIN issues i ON i.id=p."issueId" WHERE e.id=$1
    UNION ALL SELECT b."sourceRunId" AS "runId",i."workspaceId",i."ownershipState" FROM improvement_skill_evaluations e
    JOIN improvement_benchmark_instances b ON b.id=e."instanceId" LEFT JOIN improvement_skill_candidates c ON c."versionId"=e."candidateVersionId"
    LEFT JOIN issues i ON i.id=c."issueId" WHERE e.id=$1`,
}

/** A self-improvement record belongs to its source runs; one whose source runs cannot be found is outside. */
export async function improvementRecordOutsideToken(user: ApiUser, record: { kind: 'run' | keyof typeof improvementSourceRuns; id: string }) {
  if (record.kind === 'run') return runOutsideToken(user, record.id)
  const workspaceId = await effectiveRequestWorkspace(user)
  if (!workspaceId) return true
  const { rows } = await pool.query<{ runId: string; workspaceId: string | null; ownershipState: string | null }>(improvementSourceRuns[record.kind], [record.id])
  if (!rows.length || rows.some(row => !row.runId || row.ownershipState !== 'bound' || row.workspaceId !== workspaceId)) return true
  const runIds = [...new Set(rows.map(row => row.runId))]
  return (await runsOutsideWorkspace(workspaceId, runIds)).size > 0
}

/** A capture belongs to its run. */
export async function captureOutsideToken(user: ApiUser, captureId: string) {
  const { rows: [capture] } = await pool.query<{ runId: string }>('SELECT "runId" FROM run_captures WHERE id=$1', [captureId])
  return capture ? runOutsideToken(user, capture.runId) : true
}

/** Provenance can be retired; the artifact keeps its immutable tenant. */
export async function artifactOutsideToken(user: ApiUser, artifactId: string) {
  const workspaceId = await effectiveRequestWorkspace(user)
  if (!workspaceId) return true
  const { rows: [artifact] } = await pool.query<{ workspaceId: string | null }>('SELECT "workspaceId" FROM artifacts WHERE id=$1', [artifactId])
  return artifact?.workspaceId !== workspaceId
}

/** The proposals, of these pending actions, outside the token's workspace: by the Bot that made them. */
export async function pendingActionsOutsideToken(user: ApiUser, ids: readonly string[]): Promise<Set<string>> {
  const scope = tokenScope(user)
  if (!scope || !ids.length) return new Set()
  const { rows } = await pool.query<{ id: string; workspaceId: string | null }>(
    'SELECT p.id, b."workspaceId" FROM pending_actions p LEFT JOIN bots b ON b.id=p."botId" WHERE p.id=ANY($1::uuid[])', [ids])
  const result = new Set<string>()
  for (const row of rows) if (await outside(scope, [row.workspaceId])) result.add(row.id)
  return result
}

/** The chat messages, of these, outside the token's workspace: by their Bot chat or group. */
export async function messagesOutsideToken(user: ApiUser, ids: readonly string[]): Promise<Set<string>> {
  const scope = tokenScope(user)
  if (!scope || !ids.length) return new Set()
  const { rows } = await pool.query<{ id: string; workspaceId: string | null }>(
    `SELECT m.id, b."workspaceId" FROM coordinator_messages m LEFT JOIN bots b ON b.id=m."botId" WHERE m.id=ANY($1::uuid[])
     UNION ALL
     SELECT m.id, c."workspaceId" FROM conversation_messages m JOIN conversations c ON c.id=m."conversationId" WHERE m.id=ANY($1::uuid[])`, [ids])
  const result = new Set<string>()
  for (const row of rows) if (await outside(scope, [row.workspaceId])) result.add(row.id)
  return result
}

/** A Bot of another workspace than the token's. */
export async function botOutsideToken(user: ApiUser, botId: string) {
  const scope = tokenScope(user)
  if (!scope) return false
  const { rows: [bot] } = await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1', [botId])
  return bot ? outside(scope, [bot.workspaceId]) : false
}

/** A group chat of another workspace than the token's. */
export async function groupOutsideToken(user: ApiUser, conversationId: string) {
  const scope = tokenScope(user)
  if (!scope) return false
  const { rows: [group] } = await pool.query<{ workspaceId: string | null }>('SELECT "workspaceId" FROM conversations WHERE id=$1::uuid', [conversationId])
  return group?.workspaceId ? outside(scope, [group.workspaceId]) : false
}
