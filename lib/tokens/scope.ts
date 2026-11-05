import 'server-only'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { tokenWorkspace } from '@/lib/tokens/principal'

/** An API session user; a personal access token pins it to one workspace. */
type ApiUser = { id: string; [tokenWorkspace]?: string }

// The workspace is the tenant: a workspace token reaches only its owner's records that
// belong to its workspace. A record belongs to the workspaces its Bot, group or task name;
// one that names none (older rows, an OAuth client's artifact) belongs to the owner's
// personal workspace, so only a token for that workspace reaches it. Without a token
// nothing is excluded, so browser sessions keep their owner-only checks.

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

async function issueWorkspaces(issueIds: readonly (string | null)[]) {
  const ids = [...new Set(issueIds.filter((id): id is string => Boolean(id)))]
  if (!ids.length) return new Map<string, string>()
  const { rows } = await workspacePool.query<{ issueId: string; workspaceId: string }>('SELECT "issueId","workspaceId" FROM mikka_team_issues WHERE "issueId"=ANY($1::uuid[])', [ids])
  return new Map(rows.map(row => [row.issueId, row.workspaceId]))
}

/** The runs, of these, outside the token's workspace: by their Bot, cloud computer binding or task. */
export async function runsOutsideToken(user: ApiUser, runIds: readonly string[]): Promise<Set<string>> {
  const scope = tokenScope(user)
  if (!scope || !runIds.length) return new Set()
  const { rows } = await pool.query<{ id: string; issueId: string | null; botWorkspace: string | null; bindingWorkspace: string | null }>(
    `SELECT r.id, r."issueId", b."workspaceId" AS "botWorkspace", c."workspaceId" AS "bindingWorkspace" FROM agent_runs r
     LEFT JOIN bots b ON b.id=r."botId" LEFT JOIN computer_run_bindings c ON c."runId"=r.id WHERE r.id=ANY($1::uuid[])`, [runIds])
  const tasks = await issueWorkspaces(rows.map(row => row.issueId))
  const result = new Set<string>()
  for (const row of rows) {
    if (await outside(scope, [row.botWorkspace, row.bindingWorkspace, row.issueId && tasks.get(row.issueId)])) result.add(row.id)
  }
  return result
}

export async function runOutsideToken(user: ApiUser, runId: string) {
  return (await runsOutsideToken(user, [runId])).has(runId)
}

// The runs a self-improvement record was made from.
const improvementSourceRuns = {
  proposal: 'SELECT "runId" FROM improvement_proposal_sources WHERE "proposalId"=$1',
  instance: 'SELECT "sourceRunId" AS "runId" FROM improvement_benchmark_instances WHERE id=$1',
  evaluation: `SELECT i."sourceRunId" AS "runId" FROM improvement_skill_evaluations e JOIN improvement_benchmark_instances i ON i.id=e."instanceId" WHERE e.id=$1
    UNION SELECT s."runId" FROM improvement_skill_evaluations e JOIN improvement_proposal_sources s ON s."proposalId"=e."proposalId" WHERE e.id=$1`,
}

/** A self-improvement record belongs to its source runs; one whose source runs cannot be found is outside. */
export async function improvementRecordOutsideToken(user: ApiUser, record: { kind: 'run' | keyof typeof improvementSourceRuns; id: string }) {
  if (!user[tokenWorkspace]) return false
  if (record.kind === 'run') return runOutsideToken(user, record.id)
  const { rows } = await pool.query<{ runId: string }>(improvementSourceRuns[record.kind], [record.id])
  const runIds = [...new Set(rows.map(row => row.runId))]
  if (!runIds.length) return true
  const { rows: found } = await pool.query<{ id: string }>('SELECT id FROM agent_runs WHERE id=ANY($1::uuid[])', [runIds])
  return found.length < runIds.length || (await runsOutsideToken(user, runIds)).size > 0
}

/** A capture belongs to its run. */
export async function captureOutsideToken(user: ApiUser, captureId: string) {
  if (!user[tokenWorkspace]) return false
  const { rows: [capture] } = await pool.query<{ runId: string }>('SELECT "runId" FROM run_captures WHERE id=$1', [captureId])
  return capture ? runOutsideToken(user, capture.runId) : false
}

/** An artifact belongs to the run that made it, else to its task. */
export async function artifactOutsideToken(user: ApiUser, artifactId: string) {
  const scope = tokenScope(user)
  if (!scope) return false
  const { rows: [artifact] } = await pool.query<{ runId: string | null; issueId: string | null }>('SELECT "runId","issueId" FROM artifacts WHERE id=$1', [artifactId])
  if (!artifact) return false
  if (artifact.runId) return runOutsideToken(user, artifact.runId)
  return outside(scope, [artifact.issueId && (await issueWorkspaces([artifact.issueId])).get(artifact.issueId)])
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
