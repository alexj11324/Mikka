import 'server-only'
import type { Pool } from 'pg'
import { getRun, start } from 'workflow/api'
import { SubagentStore } from './subagent-store'
import { subagentNotice } from './subagent-notice'
import * as provider from './e2b-provider'
import { finishSuggestionSubagent } from '@/lib/suggestions/execution'
import { botWebWorker } from '@/workflows/subagents/workflow'
import { renewBotLifetime } from './bot-heartbeat'

type Orphan = { id: string; ownerId: string; workspaceId: string; workerKey: string }

/** Call only after verifying the durable workflow is terminal. If closing the
 * browser fails, rollback leaves the task and capacity slot intact. */
export async function failOrphanedSubagent(pool: Pool, orphan: Orphan, runtime = provider) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${orphan.workspaceId}`])
    const row = (await client.query(`SELECT s.*,m."sandboxId",p.version FROM bot_subagents s
      LEFT JOIN cloud_machines m ON m."workspaceId"=s."workspaceId" AND m."ownerId"=s."ownerId"
      LEFT JOIN workspace_computer_policies p ON p."workspaceId"=s."workspaceId"
      WHERE s.id=$1 AND s."workerKey"=$2 AND s."ownerId"=$3 AND s."workspaceId"=$4 AND s.state IN ('running','needs_you') FOR UPDATE OF s`,
    [orphan.id, orphan.workerKey, orphan.ownerId, orphan.workspaceId])).rows[0]
    if (row) {
      if (row.sandboxId) {
        const sandbox = await runtime.connectComputer(row.sandboxId)
        if (row.browserContextId) await runtime.syncSubagentLease(sandbox, { subagentId: row.id, botId: row.botId, ownerId: row.ownerId, workspaceId: row.workspaceId,
          epoch: row.epoch + 1, controlledBy: null, controlUntil: 0, computerAllowed: false, policyVersion: row.version ?? 0, stopRequested: true })
        await runtime.stopSubagentBrowser(sandbox, row.id)
      }
      await client.query(`UPDATE bot_subagents SET state='failed',control='idle',"browserContextId"=NULL,"haltedAt"=coalesce("haltedAt",now()),
        "endedAt"=now(),result='The browser worker stopped before reporting a result.' WHERE id=$1`, [row.id])
    }
    await client.query('COMMIT')
    return Boolean(row)
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** Recover a stop whose request ended while the browser was closing and
 * repair terminal chat/suggestion updates. Never free a slot before close. */
export async function reconcileSubagents(pool: Pool) {
  let stopped = 0, reported = 0, failed = 0
  const activeMachines = await pool.query(`SELECT DISTINCT m."workspaceId",m."ownerId",m."lastActiveAt" FROM cloud_machines m
    JOIN bot_subagents s ON s."workspaceId"=m."workspaceId" AND s."ownerId"=m."ownerId"
    WHERE m.state='running' AND m."sandboxId" IS NOT NULL AND s.state IN ('running','needs_you') AND s."stopRequestedAt" IS NULL
    ORDER BY m."lastActiveAt" LIMIT 50`)
  const renewals = await Promise.allSettled(activeMachines.rows.map(row => renewBotLifetime(pool, { userId: row.ownerId, workspaceId: row.workspaceId })))
  failed += renewals.filter(result => result.status === 'rejected').length
  const pending = await pool.query(`SELECT s.id,s."botId",s."ownerId",s."workspaceId" FROM bot_subagents s
    WHERE s.state IN ('running','needs_you') AND s."stopRequestedAt" IS NOT NULL ORDER BY s."stopRequestedAt" LIMIT 1`)
  for (const row of pending.rows) {
    try { await new SubagentStore(pool).operate({ userId: row.ownerId, workspaceId: row.workspaceId }, row.botId, row.id, 'stop'); stopped++ }
    catch { failed++ }
  }
  // A completed/failed workflow cannot own a live browser. Preserve the slot
  // until its private browser has actually closed, then report a failure.
  const orphan = (await pool.query(`SELECT id,"botId","ownerId","workspaceId","workerKey" FROM bot_subagents
    WHERE state IN ('running','needs_you') AND "stopRequestedAt" IS NULL AND "workerKey" IS NOT NULL
      AND "startedAt"<now()-interval '15 minutes' ORDER BY "startedAt" LIMIT 1`)).rows[0]
  if (orphan) {
    try {
      const status = await getRun(orphan.workerKey).status
      if (['completed','failed','cancelled'].includes(status)) {
        if (await failOrphanedSubagent(pool, orphan)) stopped++
      }
    } catch { failed++ }
  }
  const terminal = await pool.query(`SELECT s.id,s."botId",s."ownerId",s."workspaceId",s.state,s.result FROM bot_subagents s
    WHERE s.state IN ('done','failed','stopped') AND (
      EXISTS (SELECT 1 FROM suggestions x WHERE x."executionSubagentId"=s.id AND x."userId"=s."ownerId" AND x."executionState"='running') OR
      NOT EXISTS (SELECT 1 FROM coordinator_events e WHERE e."dedupeKey"='subagent:'||s.id::text||':finished'))
    ORDER BY s."endedAt" NULLS LAST LIMIT 5`)
  for (const row of terminal.rows) {
    try {
      await finishSuggestionSubagent(pool, row.ownerId, row.id, row.state)
      await subagentNotice(pool, { userId: row.ownerId, workspaceId: row.workspaceId }, row.botId, row.id, 'finished', { state: row.state, ...(row.result ? { result: row.result } : {}) })
      reported++
    } catch { failed++ }
  }
  if (process.env.MIKKA_BOT_SUBAGENTS === '1') {
    const queued = await pool.query(`SELECT q."ownerId",q."workspaceId",count(*)::int AS queued,
      (SELECT count(*)::int FROM bot_subagents a WHERE a."workspaceId"=q."workspaceId" AND a.state IN ('running','needs_you')) AS active
      FROM bot_subagents q WHERE q.state='queued' GROUP BY q."ownerId",q."workspaceId" ORDER BY min(q."createdAt") LIMIT 1`)
    for (const row of queued.rows) {
      const count = Math.min(row.queued, Math.max(0, 6 - row.active))
      for (let i = 0; i < count; i++) {
        try { await start(botWebWorker, [{ userId: row.ownerId, workspaceId: row.workspaceId }]) } catch { failed++ }
      }
    }
  }
  return { stopped, reported, failed }
}
