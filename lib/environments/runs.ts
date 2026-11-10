import 'server-only'
import type { Pool } from 'pg'
import {
  environmentSetupCommand, environmentSnapshotSchema,
  EnvironmentRequestError, type EnvironmentActionKind, type EnvironmentSnapshot, type RunActionExecutionSummary,
  type RunActionExecutionView, type RunActionStatus,
} from './contract'
import { defaultEnvironmentForRun, type EnvironmentRow } from './store'

export type Query = Pick<Pool, 'query'>

export type RunEnvironmentBindingRow = {
  runId: string
  ownerId: string
  workspaceId: string
  environmentId: string
  revision: number
  snapshot: unknown
  frozenAt: Date
}

export type FrozenRunEnvironment = {
  environment: EnvironmentSnapshot
  /** The claim's setup overlay for the daemon's existing approved-recipe path. */
  setupCommand: string | null
}

const bindingColumns = `"runId","ownerId","workspaceId","environmentId",revision,snapshot,"frozenAt"`

/** A run keeps the environment it was first claimed with. Returns an existing
 * binding unchanged; otherwise freezes the current project/workspace default.
 * A null means the run has no default environment, not an error. */
export async function freezeRunEnvironment(database: Pool, workspaceDatabase: Query, input: {
  runId: string; ownerId: string; workspaceId: string; issueId: string | null; repositoryKey: string
}): Promise<FrozenRunEnvironment | null> {
  const existing = await readRunEnvironmentBinding(database, input.runId)
  if (existing) return frozen(existing)
  const environment = await defaultEnvironmentForRun(workspaceDatabase, {
    workspaceId: input.workspaceId, issueId: input.issueId, repositoryKey: input.repositoryKey,
  })
  if (!environment) return null
  await database.query(
    `INSERT INTO run_environment_bindings ("runId","ownerId","workspaceId","environmentId",revision,snapshot)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT ("runId") DO NOTHING`,
    [input.runId, input.ownerId, input.workspaceId, environment.id, environment.revision, JSON.stringify(snapshotOfRow(environment))],
  )
  const frozenRow = await readRunEnvironmentBinding(database, input.runId)
  return frozenRow ? frozen(frozenRow) : null
}

function snapshotOfRow(row: EnvironmentRow): EnvironmentSnapshot {
  return environmentSnapshotSchema.parse({
    environmentId: row.id, revision: row.revision, name: row.name, description: row.description,
    runtime: row.runtime, workdir: row.workdir, setupScript: row.setupScript, installScript: row.installScript,
    actions: row.actions, repositories: row.repositories,
  })
}

function frozen(row: RunEnvironmentBindingRow): FrozenRunEnvironment {
  const parsed = environmentSnapshotSchema.safeParse(row.snapshot)
  if (!parsed.success) throw new EnvironmentRequestError('environmentInvalid', 500, { cause: parsed.error })
  return { environment: parsed.data, setupCommand: environmentSetupCommand(parsed.data) }
}

/** The snapshot of an already frozen binding, for read-only panels. */
export function environmentSnapshot(binding: RunEnvironmentBindingRow): EnvironmentSnapshot {
  return frozen(binding).environment
}

export async function readRunEnvironmentBinding(database: Query, runId: string): Promise<RunEnvironmentBindingRow | null> {
  const { rows: [row] } = await database.query<RunEnvironmentBindingRow>(
    `SELECT ${bindingColumns} FROM run_environment_bindings WHERE "runId"=$1`, [runId])
  return row ?? null
}

export type RunActionExecutionRow = {
  id: string
  runId: string
  ownerId: string
  workspaceId: string
  environmentId: string
  environmentRevision: number
  actionId: string
  actionName: string
  actionKind: EnvironmentActionKind
  command: string
  cwd: string
  timeoutSeconds: number
  status: RunActionStatus
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  errorCode: string | null
  sandboxId: string | null
  pid: number | null
  requestKey: string | null
  requestedBy: string
  cancelRequestedAt: Date | null
  startedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
}

const executionColumns = `id,"runId","ownerId","workspaceId","environmentId","environmentRevision","actionId","actionName","actionKind",command,cwd,"timeoutSeconds",status,"exitCode",stdout,stderr,truncated,"errorCode","sandboxId",pid,"requestKey","requestedBy","cancelRequestedAt","startedAt","finishedAt","createdAt"`

const iso = (value: Date | null) => value ? value.toISOString() : null
export function executionView(row: RunActionExecutionRow): RunActionExecutionView {
  return {
    id: row.id, runId: row.runId, environmentId: row.environmentId, environmentRevision: row.environmentRevision,
    actionId: row.actionId, actionName: row.actionName, actionKind: row.actionKind, command: row.command, timeoutSeconds: row.timeoutSeconds,
    status: row.status, exitCode: row.exitCode, stdout: row.stdout, stderr: row.stderr, truncated: row.truncated,
    errorCode: row.errorCode, createdAt: row.createdAt.toISOString(), startedAt: iso(row.startedAt), finishedAt: iso(row.finishedAt),
  }
}
export function executionSummary(row: RunActionExecutionRow): RunActionExecutionSummary {
  const { stdout: _stdout, stderr: _stderr, ...summary } = executionView(row)
  return summary
}

export async function readRunActionExecution(database: Query, runId: string, executionId: string): Promise<RunActionExecutionRow | null> {
  const { rows: [row] } = await database.query<RunActionExecutionRow>(
    `SELECT ${executionColumns} FROM run_action_executions WHERE id=$1 AND "runId"=$2`, [executionId, runId])
  return row ?? null
}

export async function readExecutionById(database: Query, executionId: string): Promise<RunActionExecutionRow | null> {
  const { rows: [row] } = await database.query<RunActionExecutionRow>(
    `SELECT ${executionColumns} FROM run_action_executions WHERE id=$1`, [executionId])
  return row ?? null
}

export async function listRunActionExecutions(database: Query, runId: string): Promise<RunActionExecutionRow[]> {
  const { rows } = await database.query<RunActionExecutionRow>(
    `SELECT ${executionColumns} FROM run_action_executions WHERE "runId"=$1 ORDER BY "createdAt" DESC LIMIT 20`, [runId])
  return rows
}

/** How many runs froze each environment; the settings list shows the count. */
export async function boundRunCounts(database: Query, workspaceId: string): Promise<Map<string, number>> {
  const { rows } = await database.query<{ environmentId: string; count: number }>(
    'SELECT "environmentId",count(*)::int AS count FROM run_environment_bindings WHERE "workspaceId"=$1 GROUP BY "environmentId"', [workspaceId])
  return new Map(rows.map(row => [row.environmentId, row.count]))
}

/** The latest execution per environment for the settings list; logs stay out. */
export async function latestExecutionByEnvironment(database: Query, workspaceId: string): Promise<Map<string, RunActionExecutionSummary>> {
  const { rows } = await database.query<RunActionExecutionRow>(
    `SELECT DISTINCT ON ("environmentId") ${executionColumns} FROM run_action_executions
     WHERE "workspaceId"=$1 ORDER BY "environmentId","createdAt" DESC`, [workspaceId])
  return new Map(rows.map(row => [row.environmentId, executionSummary(row)]))
}

export type EligibleActionRun = { id: string; status: string; issueTitle: string | null; startedAt: string | null }

/** Cloud runs of this owner with a live task machine: the only machine kind a
 * server run action can reach in this slice. */
export async function eligibleActionRuns(database: Query, workspaceId: string, ownerId: string): Promise<EligibleActionRun[]> {
  const { rows } = await database.query<{ id: string; status: string; issueTitle: string | null; startedAt: Date | null }>(
    `SELECT r.id,r.status,i.title AS "issueTitle",r."startedAt"
     FROM agent_runs r
     JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d.kind='cloud' AND d.enabled
     LEFT JOIN issues i ON i.id=r."issueId"
     WHERE r."workspaceId"=$1 AND r."userId"=$2
       AND r.status IN ('preparing','running','waiting_input','finishing') AND r."stopRequestedAt" IS NULL
       AND EXISTS (SELECT 1 FROM thread_machines m WHERE m."runId"=r.id AND m."ownerId"=r."userId"
         AND m.state='running' AND m."sandboxId" IS NOT NULL)
     ORDER BY r."startedAt" DESC NULLS LAST LIMIT 5`, [workspaceId, ownerId])
  return rows.map(row => ({ id: row.id, status: row.status, issueTitle: row.issueTitle, startedAt: iso(row.startedAt) }))
}

/** A live-machine check for the run-action panel, without reserving anything. */
export async function runActionMachine(database: Query, runId: string, ownerId: string, workspaceId: string): Promise<{
  deviceKind: string
  sandboxId: string | null
  machineState: string | null
  worktreePath: string | null
} | null> {
  const { rows: [row] } = await database.query<{ deviceKind: string; sandboxId: string | null; machineState: string | null; worktreePath: string | null }>(
    `SELECT d.kind AS "deviceKind",m."sandboxId",m.state AS "machineState",r."worktreePath"
     FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
     LEFT JOIN LATERAL (SELECT m."sandboxId",m.state FROM thread_machines m
       WHERE m."runId"=r.id AND m."ownerId"=r."userId"
       ORDER BY (m.state='running') DESC, m."startedAt" DESC LIMIT 1) m ON true
     WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=$3`, [runId, ownerId, workspaceId])
  return row ?? null
}

export type CreateExecutionResult =
  | { kind: 'created'; execution: RunActionExecutionRow }
  | { kind: 'replayed'; execution: RunActionExecutionRow }
  | { kind: 'busy' }

/** Stale rows from a crashed worker would block the next action forever; a
 * queued/running row older than this is marked failed before a new insert. */
export const STALE_EXECUTION_MINUTES = 30

export async function createRunActionExecution(database: Pool, input: {
  id: string
  runId: string
  ownerId: string
  workspaceId: string
  environmentId: string
  environmentRevision: number
  actionId: string
  actionName: string
  actionKind: EnvironmentActionKind
  command: string
  cwd: string
  sandboxId: string
  timeoutSeconds: number
  requestKey: string | null
  requestedBy: string
}): Promise<CreateExecutionResult> {
  if (input.requestKey) {
    const prior = await database.query<RunActionExecutionRow>(
      `SELECT ${executionColumns} FROM run_action_executions WHERE "runId"=$1 AND "requestKey"=$2`, [input.runId, input.requestKey])
    if (prior.rows[0]) return { kind: 'replayed', execution: prior.rows[0] }
  }
  await database.query(
    `UPDATE run_action_executions SET status='failed',"errorCode"='stale',"finishedAt"=now()
     WHERE "runId"=$1 AND status IN ('queued','running') AND "createdAt" < now()-interval '${STALE_EXECUTION_MINUTES} minutes'`,
    [input.runId])
  try {
    const { rows: [row] } = await database.query<RunActionExecutionRow>(
      `INSERT INTO run_action_executions (id,"runId","ownerId","workspaceId","environmentId","environmentRevision",
        "actionId","actionName","actionKind",command,cwd,"sandboxId","timeoutSeconds",status,"requestKey","requestedBy")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'queued',$14,$15) RETURNING ${executionColumns}`,
      [input.id, input.runId, input.ownerId, input.workspaceId, input.environmentId, input.environmentRevision,
        input.actionId, input.actionName, input.actionKind, input.command, input.cwd, input.sandboxId,
        input.timeoutSeconds, input.requestKey, input.requestedBy])
    return { kind: 'created', execution: row! }
  } catch (error) {
    const value = error && typeof error === 'object' ? error as { code?: unknown; constraint?: unknown } : {}
    if (value.code !== '23505') throw new EnvironmentRequestError('environmentUnavailable', 500, { cause: error })
    if (typeof value.constraint === 'string' && value.constraint.includes('request_key')) {
      const prior = input.requestKey
        ? await database.query<RunActionExecutionRow>(`SELECT ${executionColumns} FROM run_action_executions WHERE "runId"=$1 AND "requestKey"=$2`, [input.runId, input.requestKey])
        : null
      if (prior?.rows[0]) return { kind: 'replayed', execution: prior.rows[0] }
    }
    return { kind: 'busy' }
  }
}

export async function markExecutionStarted(database: Query, id: string): Promise<boolean> {
  const { rowCount } = await database.query(
    `UPDATE run_action_executions SET status='running',"startedAt"=COALESCE("startedAt",now())
     WHERE id=$1 AND status='queued'`, [id])
  return Boolean(rowCount)
}

/** Record the provider process so another server instance can cancel it. */
export async function recordExecutionProcess(database: Query, id: string, sandboxId: string, pid: number | null): Promise<void> {
  await database.query(`UPDATE run_action_executions SET "sandboxId"=$2,pid=$3 WHERE id=$1 AND status='running'`, [id, sandboxId, pid])
}

/** Each flush stores bounded, already-masked output. */
export async function flushExecutionOutput(database: Query, id: string, output: { stdout: string; stderr: string; truncated: boolean }): Promise<void> {
  await database.query(
    `UPDATE run_action_executions SET stdout=$2,stderr=$3,truncated=$4 WHERE id=$1 AND status='running'`,
    [id, output.stdout, output.stderr, output.truncated])
}

export async function finishExecution(database: Query, id: string, input: {
  status: Extract<RunActionStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>
  exitCode: number | null
  errorCode: string | null
  output: { stdout: string; stderr: string; truncated: boolean }
}): Promise<void> {
  await database.query(
    `UPDATE run_action_executions SET status=$2,"exitCode"=$3,"errorCode"=$4,stdout=$5,stderr=$6,truncated=$7,"finishedAt"=now()
     WHERE id=$1 AND status IN ('queued','running')`,
    [id, input.status, input.exitCode, input.errorCode, input.output.stdout, input.output.stderr, input.output.truncated])
}

export async function markExecutionCancelledIfQueued(database: Query, id: string): Promise<void> {
  await database.query(
    `UPDATE run_action_executions SET status='cancelled',"errorCode"='cancelled',"finishedAt"=now()
     WHERE id=$1 AND status='queued'`, [id])
}

export async function cancelExecution(database: Query, runId: string, executionId: string): Promise<RunActionExecutionRow | null> {
  const { rows: [row] } = await database.query<RunActionExecutionRow>(
    `UPDATE run_action_executions SET "cancelRequestedAt"=COALESCE("cancelRequestedAt",now())
     WHERE id=$1 AND "runId"=$2 AND status IN ('queued','running') RETURNING ${executionColumns}`,
    [executionId, runId])
  return row ?? null
}
