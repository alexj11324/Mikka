import 'server-only'
import type { Pool } from 'pg'
import { ActionFailureError } from './action-error'
import { factoryEventId } from './factory/event-id'
import { runChanged } from './live/panels'
import { readRunChain, type RunChain } from './run-chain'
import { UNFINISHED_RUN_STATUSES } from './agent-run-statuses'
import { withFactoryBackgroundWorkspace } from './factory/background-workspace'

type QueueRow = {
  id: string
  requestId: string
  runId: string
  rootRunId: string
  userId: string
  workspaceId: string
  text: string
  status: 'queued' | 'delivering' | 'cancelled' | 'sent' | 'failed'
  claimRunId?: string | null
  claimMode?: 'steer' | 'afterRun' | null
  failureCode: string | null
}

const isActive = (status?: string) => UNFINISHED_RUN_STATUSES.some(value => value === status)

export async function readQueuedReplyReceipt(pool: Pool, userId: string, chain: RunChain, text: string, requestId: string) {
  const id = factoryEventId('thread-queue', JSON.stringify([userId, requestId]))
  const { rows: [row] } = await pool.query<QueueRow>('SELECT * FROM thread_queued_messages WHERE id=$1 AND "userId"=$2', [id, userId])
  if (!row) return null
  return withFactoryBackgroundWorkspace(pool, userId, { kind: 'run', id: row.runId }, async () => {
    if (row.text !== text || row.rootRunId !== chain.rootRunId) throw new ActionFailureError('submissionConflict')
    return { runId: row.runId, continued: false }
  })
}

export async function queueThreadReply(pool: Pool, userId: string, chain: RunChain, text: string, requestId: string) {
  const id = factoryEventId('thread-queue', JSON.stringify([userId, requestId]))
  return withFactoryBackgroundWorkspace(pool, userId, { kind: 'run', id: chain.latestRunId }, async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [run] } = await client.query<{ status: string; workspaceId: string; stopRequestedAt: Date | null; issueId: string | null; deviceRepoId: string | null }>(
        'SELECT status,"workspaceId","stopRequestedAt","issueId","deviceRepoId" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [chain.latestRunId, userId])
      if (!run) throw new ActionFailureError('runNotFound')
      // A replay can arrive after the original anchor finished. Match its
      // immutable request first, so it does not start a second execution.
      const dispatchId = factoryEventId('thread-submission', JSON.stringify([userId, requestId]))
      const previous = await client.query('SELECT id FROM coordinator_events WHERE id=$1 AND "userId"=$2', [dispatchId, userId])
      if (previous.rowCount) throw new ActionFailureError('submissionConflict')
      const { rows: [saved] } = await client.query<QueueRow>(
        'SELECT * FROM thread_queued_messages WHERE id=$1 AND "userId"=$2', [id, userId])
      if (saved && (saved.rootRunId !== chain.rootRunId || saved.workspaceId !== run.workspaceId || saved.text !== text))
        throw new ActionFailureError('submissionConflict')
      if (!saved && (!run.issueId || !run.deviceRepoId)) throw new ActionFailureError('threadDeliveryUnavailable')
      if (!saved && (!isActive(run.status) || run.stopRequestedAt)) throw new ActionFailureError('threadStopping')
      if (!saved) await client.query(`INSERT INTO thread_queued_messages(id,"userId","workspaceId","rootRunId","runId",text,"requestId")
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, userId, run.workspaceId, chain.rootRunId, chain.latestRunId, text, requestId])
      await client.query('COMMIT')
      if (!saved) await runChanged(pool, chain.latestRunId)
      return { runId: saved?.runId ?? chain.latestRunId, continued: false }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  })
}

export async function threadDeliveryView(pool: Pool, ownerId: string, rootRunId: string, latestRunId: string): Promise<import('./thread-delivery').ThreadDeliveryView> {
  const { rows: [run] } = await pool.query<{ workspaceId: string; status: string; stopRequestedAt: Date | null; harness: string; interrupt: boolean; continuable: boolean }>(
    `SELECT r."workspaceId",r.status,r."stopRequestedAt",coalesce(r."agentDefinition"->>'harness',a.harness) AS harness,
       (r."issueId" IS NOT NULL AND r."deviceRepoId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM factory_attempts f WHERE f."runId"=r.id AND f.stage IN ('review','verify','monitor'))) AS continuable,
       EXISTS (SELECT 1 FROM factory_tasks t JOIN factory_attempts f ON f.id=t."attemptId" WHERE f."runId"=r.id
         AND t."userId"=r."userId" AND t."workspaceId"=r."workspaceId" AND t."issueId"=r."issueId"
         AND t.status='running' AND NOT (t.stage='spec' AND coalesce(t.route->'flowVersion','1'::jsonb)='2'::jsonb)) AS interrupt
       FROM agent_runs r JOIN agents a ON a.id=r."agentId" WHERE r.id=$1 AND r."userId"=$2`, [latestRunId, ownerId])
  if (!run?.workspaceId) return { modes: [], queued: [] }
  const modes: import('./thread-delivery').ThreadDeliveryMode[] = []
  if (['preparing','running','finishing','queued'].includes(run.status) && !run.stopRequestedAt) {
    if (run.continuable) modes.push('queue')
    if (run.status === 'running' && run.harness === 'codex') modes.push('steer')
    if (run.interrupt) modes.push('interrupt')
  }
  const workspaceId = run.workspaceId
  const { rows } = await pool.query<Pick<QueueRow,'id'|'text'|'status'|'failureCode'|'requestId'>>(
    `SELECT id,text,status,"failureCode","requestId" FROM thread_queued_messages
     WHERE "userId"=$1 AND "workspaceId"=$2 AND "rootRunId"=$3 AND status IN ('queued','delivering','failed')
     ORDER BY "createdAt",id`, [ownerId, workspaceId, rootRunId])
  return { modes, queued: rows }
}

export async function cancelQueuedThreadReply(pool: Pool, userId: string, runId: string, messageId: string) {
  return withFactoryBackgroundWorkspace(pool, userId, { kind: 'run', id: runId }, async () => {
    const chain = await readRunChain(pool, userId, runId)
    if (!chain) throw new ActionFailureError('runNotFound')
    const { rows: [row] } = await pool.query<Pick<QueueRow,'status'>>(`UPDATE thread_queued_messages q SET status='cancelled'
      FROM agent_runs r WHERE r.id=$1 AND r."userId"=$2 AND r."workspaceId"=q."workspaceId"
      AND q."rootRunId"=$3 AND q."userId"=$2 AND q.id=$4 AND q.status IN ('queued','cancelled')
      RETURNING q.status`, [runId, userId, chain.rootRunId, messageId])
    if (row) { await runChanged(pool, runId); return 'cancelled' as const }
    const prior = await pool.query('SELECT 1 FROM thread_queued_messages WHERE id=$1 AND "userId"=$2 AND "rootRunId"=$3', [messageId, userId, chain.rootRunId])
    if (!prior.rowCount) throw new ActionFailureError('runNotFound')
    return 'tooLate' as const
  })
}

/** The terminal receipt is the wake. Serializing claims on the root prevents
 * completion replay and concurrent send-now from admitting the same message. */
export async function deliverQueuedThreadReply(pool: Pool, userId: string, runId: string, sendNowId?: string) {
  const possible = await pool.query(`SELECT bool_or(q.status='delivering') AS "hasClaim" FROM thread_queued_messages q JOIN agent_runs r ON r.id=$1
    AND r."userId"=q."userId" AND r."workspaceId"=q."workspaceId" WHERE q."userId"=$2 AND q.status IN ('queued','delivering')
    AND (q."claimRunId"=$1 OR q."runId"=$1 OR EXISTS (SELECT 1 FROM thread_queued_messages previous WHERE previous."rootRunId"=q."rootRunId"
      AND previous."sentRunId"=$1)) GROUP BY q."userId"`, [runId, userId])
  if (!possible.rowCount) return false
  return withFactoryBackgroundWorkspace(pool, userId, { kind: 'run', id: runId }, async () => {
    const chain = await readRunChain(pool, userId, runId)
    if (!chain) return false
    const recoverOnly = !sendNowId && (chain.latestRunId !== runId || isActive(chain.attempts.at(-1)?.status))
    if (recoverOnly && !possible.rows[0]?.hasClaim) return false
    if (!sendNowId && !recoverOnly && chain.attempts.at(-1)?.status !== 'succeeded') {
      // A stopped/revoked run must never restart just because input was queued.
      // Preserve the user's text and expose the failed prerequisite.
      const held = await pool.query(`UPDATE thread_queued_messages SET status='failed',"failureCode"='threadDeliveryUnavailable'
        WHERE "userId"=$1 AND "rootRunId"=$2 AND status='queued' RETURNING id`, [userId, chain.rootRunId])
      if (held.rowCount) await runChanged(pool, runId)
      return false
    }
    const client = await pool.connect()
    let claimed: QueueRow | undefined
    try {
      await client.query('BEGIN')
      const { rows: [root] } = await client.query<{ workspaceId: string; threadReplacedBy: string | null }>(
        'SELECT "workspaceId","threadReplacedBy" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [chain.rootRunId, userId])
      if (!root || root.threadReplacedBy) throw new ActionFailureError('threadReplaced')
      // A process may disappear after claiming or after the host admitted a
      // continuation. Reuse the claim's exact request, target and mode. The
      // ordinary submission receipt fences competing replays.
      const { rows: [inFlight] } = await client.query<QueueRow>(
        `SELECT * FROM thread_queued_messages WHERE "userId"=$1 AND "workspaceId"=$2 AND "rootRunId"=$3
           AND status='delivering' ORDER BY "createdAt",id LIMIT 1`, [userId, root.workspaceId, chain.rootRunId])
      if (inFlight && (!sendNowId || inFlight.id === sendNowId)) claimed = inFlight
      else if (!inFlight && !recoverOnly) {
        const { rows } = await client.query<QueueRow>(`UPDATE thread_queued_messages SET status='delivering',"claimRunId"=$5,"claimMode"=$6
          WHERE id=(SELECT id FROM thread_queued_messages q WHERE q."userId"=$1 AND q."workspaceId"=$2 AND q."rootRunId"=$3
            AND q.status='queued' AND ($4::uuid IS NULL OR q.id=$4) ORDER BY q."createdAt",q.id LIMIT 1) RETURNING *`,
          [userId, root.workspaceId, chain.rootRunId, sendNowId ?? null, chain.latestRunId, sendNowId ? 'steer' : 'afterRun'])
        claimed = rows[0]
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    if (!claimed) return false
    try {
      const { sendThreadMessage } = await import('./thread-continue')
      // The worker cannot answer questions or promote a queued message into
      // a replacement request. Recheck the exact run under ordinary admission.
      if (!claimed.claimRunId || !claimed.claimMode) throw new ActionFailureError('threadRecoveryUnavailable')
      const sent = await sendThreadMessage(userId, claimed.claimRunId, claimed.text, 'user', claimed.id, claimed.claimMode)
      await pool.query("UPDATE thread_queued_messages SET status='sent',\"sentRunId\"=$2 WHERE id=$1 AND status='delivering'", [claimed.id, sent.runId])
    } catch (error) {
      // Another replay can be between admission and writing its outcome.
      // Preserve that in-flight claim until its host receipt can be recovered.
      if (error instanceof Error && error.message === 'threadSubmissionOutcomeUnconfirmed') return false
      const failure = error instanceof ActionFailureError ? error.code : 'threadRecoveryUnavailable'
      await pool.query(`UPDATE thread_queued_messages SET status='failed',"failureCode"=$2 WHERE id=$1 AND status='delivering'`,
        [claimed.id, failure])
      throw error
    } finally { await runChanged(pool, chain.latestRunId) }
    return true
  })
}
