import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** Commit the click and the inbox event together; concurrent clicks cannot
 * enqueue the same suggestion twice. External content is passed as data. */
export async function startSuggestion(pool: Pool, userId: string, suggestionId: string) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const item = (await client.query(`SELECT id,source,action,title,"actionTitle",url,actor,"executionState"
      FROM suggestions WHERE id=$1 AND "userId"=$2 AND shown=true AND "dismissedAt" IS NULL FOR UPDATE`, [suggestionId, userId])).rows[0]
    if (!item) { await client.query('COMMIT'); return null }
    if (item.executionState === 'running' || item.executionState === 'completed') {
      await client.query('COMMIT')
      return { suggestionId, state: item.executionState as 'running' | 'completed', created: false }
    }
    const eventId = randomUUID()
    const payload = { suggestionId, source: item.source, action: item.action,
      title: String(item.actionTitle || item.title).slice(0, 1000),
      url: typeof item.url === 'string' ? item.url.slice(0, 4000) : null,
      actor: typeof item.actor === 'string' ? item.actor.slice(0, 300) : null }
    await client.query(`INSERT INTO coordinator_events (id,"userId",kind,"dedupeKey",payload,tier)
      VALUES ($1,$2,'suggestion_start',$3,$4,'attention')`, [eventId, userId, `suggestion-start:${eventId}`, JSON.stringify(payload)])
    await client.query(`UPDATE suggestions SET "executionState"='running',"executionStartedAt"=now(),
      "executionFinishedAt"=NULL,"executionRunId"=NULL,"executionSubagentId"=NULL WHERE id=$1`, [suggestionId])
    await client.query('COMMIT')
    return { suggestionId, state: 'running' as const, created: true }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

/** A model may only attach work to a suggestion the same person started. */
export async function attachSuggestionRun(pool: Pool, userId: string, suggestionId: string, runId: string): Promise<boolean> {
  const result = await pool.query<{ status: string }>(`UPDATE suggestions s SET "executionRunId"=r.id
    FROM agent_runs r WHERE s.id=$1 AND s."userId"=$2 AND s."executionState"='running'
      AND s."executionSubagentId" IS NULL AND (s."executionRunId" IS NULL OR s."executionRunId"=r.id)
      AND r.id=$3 AND r."userId"=s."userId" RETURNING r.status`, [suggestionId, userId, runId])
  if (result.rows[0]) await finishSuggestionRun(pool, userId, runId, result.rows[0].status)
  return result.rowCount === 1
}

export async function finishSuggestionRun(pool: Pool, userId: string, runId: string, status: string): Promise<void> {
  if (!['succeeded', 'failed', 'stopped', 'cancelled'].includes(status)) return
  await pool.query(`UPDATE suggestions SET "executionState"=$3,"executionFinishedAt"=now(),
      "dismissedAt"=CASE WHEN $3='completed' THEN COALESCE("dismissedAt",now()) ELSE "dismissedAt" END
    WHERE "userId"=$1 AND "executionRunId"=$2 AND "executionState"='running'`,
  [userId, runId, status === 'succeeded' ? 'completed' : 'failed'])
}

export async function attachSuggestionSubagent(pool: Pool, userId: string, suggestionId: string, subagentId: string): Promise<boolean> {
  const result = await pool.query<{ state: string }>(`UPDATE suggestions s SET "executionSubagentId"=b.id
    FROM bot_subagents b WHERE s.id=$1 AND s."userId"=$2 AND s."executionState"='running'
      AND s."executionRunId" IS NULL AND (s."executionSubagentId" IS NULL OR s."executionSubagentId"=b.id)
      AND b.id=$3 AND b."ownerId"=s."userId" RETURNING b.state`, [suggestionId, userId, subagentId])
  if (result.rows[0]) await finishSuggestionSubagent(pool, userId, subagentId, result.rows[0].state)
  return result.rowCount === 1
}

export async function finishSuggestionSubagent(pool: Pool, userId: string, subagentId: string, state: string): Promise<void> {
  if (!['done', 'failed', 'stopped'].includes(state)) return
  await pool.query(`UPDATE suggestions SET "executionState"=$3,"executionFinishedAt"=now(),
      "dismissedAt"=CASE WHEN $3='completed' THEN COALESCE("dismissedAt",now()) ELSE "dismissedAt" END
    WHERE "userId"=$1 AND "executionSubagentId"=$2 AND "executionState"='running'`,
  [userId, subagentId, state === 'done' ? 'completed' : 'failed'])
}

/** A turn that did not actually dispatch work must not leave a card claiming
 * that work is running. The person can retry a failed suggestion. */
export async function failUnattachedSuggestions(pool: Pool, userId: string, suggestionIds: readonly string[]) {
  if (!suggestionIds.length) return
  await pool.query(`UPDATE suggestions SET "executionState"='failed',"executionFinishedAt"=now()
    WHERE "userId"=$1 AND id=ANY($2::uuid[]) AND "executionState"='running'
      AND "executionRunId" IS NULL AND "executionSubagentId" IS NULL`, [userId, suggestionIds])
}
