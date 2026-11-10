import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { resolveThreadMode, threadModeSchema, type ThreadMode, type ThreadModeState } from '@mikka/protocol/thread-mode'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { recordAudit } from '@/lib/audit/record'
import { writeTransaction } from '@/lib/operations/write-transaction'

/** A thread mode transition was asked for with an old picker value. */
export class ThreadModeConflict extends Error { constructor(readonly reason: 'threadModeChanged' | 'threadModeLocked') { super(reason) } }

interface StoredMode { mode: string; version: number }

/**
 * The thread row for one person's task, created as execute on first use.
 * The caller must already hold the issue/task authorization; this row only
 * stores the person's choice, never grants task access.
 */
export async function lockThreadMode(client: Pick<PoolClient, 'query'>, userId: string, issueId: string): Promise<{ mode: ThreadMode; version: number }> {
  // The insert is idempotent; the SELECT then locks whichever row committed.
  await client.query(`INSERT INTO task_thread_modes ("userId","issueId",mode,version,"updatedBy") VALUES ($1,$2,'execute',0,$1) ON CONFLICT ("userId","issueId") DO NOTHING`, [userId, issueId])
  const { rows: [row] } = await client.query<StoredMode>(`SELECT mode,version FROM task_thread_modes WHERE "userId"=$1 AND "issueId"=$2 FOR UPDATE`, [userId, issueId])
  if (!row) throw new Error('threadModeUnavailable')
  return { mode: resolveThreadMode(row.mode), version: row.version }
}

/** Read-only view for a run's owner; no lock and no creation. */
export async function readThreadMode(query: Pick<Pool | PoolClient, 'query'>, userId: string, issueId: string): Promise<{ mode: ThreadMode; version: number }> {
  const { rows: [row] } = await query.query<StoredMode>(`SELECT mode,version FROM task_thread_modes WHERE "userId"=$1 AND "issueId"=$2`, [userId, issueId])
  return row ? { mode: resolveThreadMode(row.mode), version: row.version } : { mode: 'execute', version: 0 }
}

/**
 * The mode an automatic continuation freezes. A provider fallback or a quota
 * continuation carries the source run's mode into the **new run** and nothing
 * else: the thread keeps whatever the person has chosen now. That matters
 * because the source run is usually already `failed`, which `unfinishedRun`
 * never blocks, so treating the carry as a transition would revert a switch the
 * person made in the meantime, invalidate the version their picker holds and
 * record `thread.mode_changed` as if they had acted.
 */
export async function carryThreadMode(query: Pick<Pool | PoolClient, 'query'>, userId: string, issueId: string, carried?: ThreadMode): Promise<ThreadMode> {
  return carried ?? (await readThreadMode(query, userId, issueId)).mode
}

async function unfinishedRun(client: Pick<Pool | PoolClient, 'query'>, userId: string, issueId: string) {
  const { rowCount } = await client.query(`SELECT 1 FROM agent_runs WHERE "userId"=$1 AND "issueId"=$2 AND status=ANY($3::text[]) LIMIT 1`, [userId, issueId, [...UNFINISHED_RUN_STATUSES]])
  return (rowCount ?? 0) > 0
}

/** Whether this thread's mode can change now: an unfinished run keeps it frozen. */
export async function threadModeLocked(query: Pick<Pool | PoolClient, 'query'>, userId: string, issueId: string) {
  return unfinishedRun(query, userId, issueId)
}

/**
 * Freeze the mode a new run is admitted with. An explicit `requested` mode is
 * a transition: it bumps the thread version and is audited. A transition is
 * refused while the thread has an unfinished run, because that run already
 * froze a different mode (and its approvals are bound to it). No requested
 * mode simply inherits the thread's current choice.
 */
export async function freezeThreadMode(client: PoolClient, input: {
  userId: string; issueId: string; workspaceId: string; requested?: ThreadMode; actorName?: string
}): Promise<ThreadMode> {
  const current = await lockThreadMode(client, input.userId, input.issueId)
  const requested = input.requested === undefined ? current.mode : threadModeSchema.parse(input.requested)
  if (requested === current.mode) return current.mode
  // The dispatch-issue advisory lock normally guarantees this; a continuation
  // can still arrive while the thread is running, and must not rewrite it.
  if (await unfinishedRun(client, input.userId, input.issueId)) throw new ThreadModeConflict('threadModeLocked')
  const version = current.version + 1
  const updated = await client.query(`UPDATE task_thread_modes SET mode=$3,version=$4,"updatedBy"=$5,"updatedAt"=now() WHERE "userId"=$1 AND "issueId"=$2 AND version=$6`,
    [input.userId, input.issueId, requested, version, input.userId, current.version])
  if (updated.rowCount !== 1) throw new ThreadModeConflict('threadModeChanged')
  await recordAudit(drizzle(client), {
    workspaceId: input.workspaceId,
    actor: { type: 'user', id: input.userId, name: input.actorName ?? input.userId },
    action: 'thread.mode_changed',
    target: { type: 'issue', id: input.issueId, label: 'thread' },
    metadata: { from: current.mode, to: requested, version },
  })
  return requested
}

/**
 * The API's explicit transition. `expectedVersion` is the version the person
 * saw; a stale value changes nothing. The caller has already proven two things
 * — the run is their own (`threadModeTarget`) and they are a current member of
 * its workspace (`requireTaskWorkspace`) — so this locks the task's row only to
 * bind the write to that workspace, never to require that they created the
 * task. The row it writes is their own `(userId, issueId)` choice.
 */
export async function setThreadMode(pool: Pick<Pool, 'connect'>, input: {
  userId: string; issueId: string; workspaceId: string; mode: ThreadMode; expectedVersion: number; actorName?: string
}): Promise<ThreadModeState> {
  const mode = threadModeSchema.parse(input.mode)
  return writeTransaction(pool, async tx => {
    // Lock the issue first, so a stale run id cannot write another tenant's
    // thread: the tenant is compared, not who created the task.
    const { rows: [issue] } = await tx.query<{ workspaceId: string | null }>(`SELECT "workspaceId" FROM issues WHERE id=$1 FOR SHARE`, [input.issueId])
    if (!issue || issue.workspaceId !== input.workspaceId) throw new ThreadModeConflict('threadModeChanged')
    const current = await lockThreadMode(tx, input.userId, input.issueId)
    if (current.version !== input.expectedVersion) throw new ThreadModeConflict('threadModeChanged')
    if (mode !== current.mode && await unfinishedRun(tx, input.userId, input.issueId)) throw new ThreadModeConflict('threadModeLocked')
    if (mode !== current.mode) {
      const version = current.version + 1
      await tx.query(`UPDATE task_thread_modes SET mode=$3,version=$4,"updatedBy"=$5,"updatedAt"=now() WHERE "userId"=$1 AND "issueId"=$2 AND version=$6`,
        [input.userId, input.issueId, mode, version, input.userId, current.version])
      await recordAudit(drizzle(tx), {
        workspaceId: input.workspaceId,
        actor: { type: 'user', id: input.userId, name: input.actorName ?? input.userId },
        action: 'thread.mode_changed',
        target: { type: 'issue', id: input.issueId, label: 'thread' },
        metadata: { from: current.mode, to: mode, version },
      })
      return { mode, version }
    }
    return { mode: current.mode, version: current.version }
  })
}

/** The run a mode API was addressed to: its task, tenant and frozen mode. */
export async function threadModeTarget(query: Pick<Pool | PoolClient, 'query'>, userId: string, runId: string) {
  const { rows: [run] } = await query.query<{ issueId: string | null; workspaceId: string | null; mode: string }>(
    `SELECT "issueId","workspaceId",mode FROM agent_runs WHERE id=$1 AND "userId"=$2`, [runId, userId])
  if (!run?.issueId || !run.workspaceId) return null
  return { issueId: run.issueId, workspaceId: run.workspaceId, frozenMode: resolveThreadMode(run.mode) }
}
