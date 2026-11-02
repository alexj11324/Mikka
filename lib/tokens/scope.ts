import 'server-only'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { tokenWorkspace } from '@/lib/tokens/principal'

/** An API session user; a personal access token pins it to one workspace. */
type ApiUser = { id: string; [tokenWorkspace]?: string }

// What a workspace token may not reach among its owner's records: those of a Bot,
// a group or a task in another workspace. Without a token nothing is excluded,
// so browser sessions keep their owner-only checks.

async function issuesElsewhere(workspaceId: string, issueIds: string[]) {
  if (!issueIds.length) return new Set<string>()
  const { rows } = await workspacePool.query<{ issueId: string }>('SELECT "issueId" FROM mikka_team_issues WHERE "issueId"=ANY($1::uuid[]) AND "workspaceId"<>$2', [issueIds, workspaceId])
  return new Set(rows.map(row => row.issueId))
}

/** The runs, of these, whose Bot or task is in another workspace than the token's. */
export async function runsOutsideToken(user: ApiUser, runIds: readonly string[]): Promise<Set<string>> {
  const workspaceId = user[tokenWorkspace]
  if (!workspaceId || !runIds.length) return new Set()
  const { rows } = await pool.query<{ id: string; issueId: string | null; botWorkspace: string | null }>(
    'SELECT r.id, r."issueId", b."workspaceId" AS "botWorkspace" FROM agent_runs r LEFT JOIN bots b ON b.id=r."botId" WHERE r.id=ANY($1::uuid[])', [runIds])
  const elsewhere = await issuesElsewhere(workspaceId, rows.flatMap(row => row.issueId ? [row.issueId] : []))
  return new Set(rows.filter(row => (row.botWorkspace !== null && row.botWorkspace !== workspaceId) || (row.issueId !== null && elsewhere.has(row.issueId))).map(row => row.id))
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
  const workspaceId = user[tokenWorkspace]
  if (!workspaceId) return false
  const { rows: [artifact] } = await pool.query<{ runId: string | null; issueId: string | null }>('SELECT "runId","issueId" FROM artifacts WHERE id=$1', [artifactId])
  if (!artifact) return false
  if (artifact.runId) return runOutsideToken(user, artifact.runId)
  return artifact.issueId ? (await issuesElsewhere(workspaceId, [artifact.issueId])).size > 0 : false
}

/** The proposals, of these pending actions, that a Bot of another workspace made. */
export async function pendingActionsOutsideToken(user: ApiUser, ids: readonly string[]): Promise<Set<string>> {
  const workspaceId = user[tokenWorkspace]
  if (!workspaceId || !ids.length) return new Set()
  const { rows } = await pool.query<{ id: string }>(
    'SELECT p.id FROM pending_actions p JOIN bots b ON b.id=p."botId" WHERE p.id=ANY($1::uuid[]) AND b."workspaceId"<>$2', [ids, workspaceId])
  return new Set(rows.map(row => row.id))
}

/** The chat messages, of these, in a Bot chat or a group of another workspace. */
export async function messagesOutsideToken(user: ApiUser, ids: readonly string[]): Promise<Set<string>> {
  const workspaceId = user[tokenWorkspace]
  if (!workspaceId || !ids.length) return new Set()
  const { rows } = await pool.query<{ id: string }>(
    `SELECT m.id FROM coordinator_messages m JOIN bots b ON b.id=m."botId" WHERE m.id=ANY($1::uuid[]) AND b."workspaceId"<>$2
     UNION ALL
     SELECT m.id FROM conversation_messages m JOIN conversations c ON c.id=m."conversationId" WHERE m.id=ANY($1::uuid[]) AND c."workspaceId"<>$2`, [ids, workspaceId])
  return new Set(rows.map(row => row.id))
}

/** A Bot of another workspace than the token's. */
export async function botOutsideToken(user: ApiUser, botId: string) {
  const workspaceId = user[tokenWorkspace]
  if (!workspaceId) return false
  const { rows: [bot] } = await pool.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1', [botId])
  return bot ? bot.workspaceId !== workspaceId : false
}
