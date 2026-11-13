import { sql } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { factoryAccepted, factoryMerged, factorySourceAllowed, FACTORY_HANDOFF_STAGES } from '../factory/public-flow'
import { runAwaitingApproval } from '../task-state-query'
import { runFailureBrief } from '../run-failure-projection'
import { OPEN_TASK_PR_STATES, TASK_REVIEW_STATUS } from '../task-state'
import type { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { InboxError, isInboxId, type InboxCommand, type InboxSource, type InboxPage, type InboxEntry } from './contract'

// Same parameter-free DB facts as the Task presentation reader, with the
// physical agent_runs table left unaliased for its correlated subqueries.
const dialect = new PgDialect()
const approvalFact = dialect.sqlToQuery(sql`${runAwaitingApproval}`.inlineParams()).sql
const failureFact = dialect.sqlToQuery(sql`${runFailureBrief}`.inlineParams()).sql

export type Scope = { personal: boolean }
export type InboxReader = Parameters<typeof import('../task-workspace').withTaskWorkspace>[0]
export type Guard = <T>(reader: InboxReader, workspaceId: string, work: (scope: Scope) => Promise<T>) => Promise<T>
export type Changed = (userId: string, workspaceId: string) => Promise<void>
type SourceRow = InboxSource & { snoozedUntil: Date | null; occurredAt: Date }
const key = (type: string, id: string) => `${type}:${id}`

/** The source's own authority is checked on every read/write. Snooze is per
 * viewer, so it never changes a teammate's task or grants execution authority. */
export class InboxStore {
  constructor(readonly pool: Pool, readonly guard: Guard, readonly changed: Changed, readonly arm: () => Promise<void>, readonly now = () => new Date()) {}

  // All Inbox views, counts and item commands share this authorized source.
  // A teammate's pending handoff may be visible while only its owner can reply.
  private sourceQuery(userId: string, workspaceId: string, scope: Scope, type?: string, id?: string) {
    return { text: `
      WITH sources AS (
        SELECT i.id,'task' AS type,'agent' AS source,i.title,i.id AS "issueId",i."userId" AS "ownerId", i."updatedAt" AS "occurredAt",
          (r.id IS NOT NULL) AS "canReply",
          attention.reason IS NOT NULL AS pending,
          NULL::timestamptz AS "rejectedAt", NULL::text AS "rejectedBy", coalesce(r.id,shared.id) AS "runId",
          coalesce(attention.reason, 'confirm') AS reason, questions.total AS "questionCount"
        FROM issues i
        LEFT JOIN LATERAL (
          SELECT id,"userId",status,outcome,"pauseReason","stopReason","threadReplacedBy",
                 (${approvalFact}) AS "awaitingApproval", (${failureFact}) AS failure
          FROM agent_runs WHERE "issueId"=i.id AND "workspaceId"=i."workspaceId" AND "userId"=$1
          ORDER BY "createdAt" DESC,id DESC LIMIT 1
        ) r ON true
        -- An authorized teammate may see an explicit request for a reply. Its
        -- existence cannot replace the current reader's Task state or grant
        -- access to the peer's private tool approvals or execution details.
        LEFT JOIN LATERAL (
          SELECT last.id FROM (
            SELECT id,status,outcome,"threadReplacedBy" FROM agent_runs
            WHERE r.id IS NULL AND "issueId"=i.id AND "workspaceId"=i."workspaceId" AND "userId"<>$1
            ORDER BY "createdAt" DESC,id DESC LIMIT 1
          ) last WHERE last."threadReplacedBy" IS NULL AND (last.status='waiting_input'
            OR (last.status NOT IN ('queued','preparing','running','finishing','paused','failed') AND last.outcome='needs_input'))
        ) shared ON true
        CROSS JOIN LATERAL (SELECT coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo') AS metadata) issue
        CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(issue.metadata->'pullRequests')='array'
          THEN issue.metadata->'pullRequests' ELSE '[]'::jsonb END AS items) pull_requests
        LEFT JOIN LATERAL (
          SELECT t.id,t.stage,t.status,t."candidateId",(${factorySourceAllowed}) AS allowed,
                 (${factoryMerged} OR ${factoryAccepted}) AS completed
          FROM factory_tasks t
          LEFT JOIN factory_candidates candidate ON candidate.id=t."candidateId" AND candidate."taskId"=t.id
          WHERE t."issueId"=i.id AND t."userId"=$1 AND t."workspaceId"=i."workspaceId"
          ORDER BY t."updatedAt" DESC,t.id DESC LIMIT 1
        ) factory ON true
        CROSS JOIN LATERAL (SELECT count(*)::integer AS total FROM factory_questions q
          WHERE q."taskId"=factory.id AND q."issueId"=i.id AND q."userId"=$1
                AND factory.allowed AND NOT factory.completed AND factory.status NOT IN ('cancelled','revoked')
                AND q."candidateId" IS NOT DISTINCT FROM factory."candidateId"
                AND q.status IN ('open','waiting_user','blocked') AND q."answerId" IS NULL
                AND (q."expiresAt" IS NULL OR q."expiresAt">now())) questions
        CROSS JOIN LATERAL (SELECT CASE
          WHEN i.status IN ('done','canceled','duplicate') THEN NULL
          WHEN questions.total>0 THEN 'needsReply'
          WHEN factory.allowed AND NOT factory.completed AND factory.status IN ('blocked','failed') THEN NULL
          WHEN factory.allowed AND NOT factory.completed AND factory.status NOT IN ('cancelled','revoked')
               AND factory.stage='clarify' AND factory.status='waiting' THEN 'needsReply'
          WHEN factory.allowed AND NOT factory.completed AND factory.status NOT IN ('cancelled','revoked')
               AND (factory.stage=ANY($8::text[]) OR (factory.stage='spec' AND factory.status='passed')) THEN 'review'
          WHEN r."threadReplacedBy" IS NULL AND r.id IS NOT NULL AND
               (r.outcome='blocked' OR r."stopReason" IN ('device_lost','quota_exhausted') OR r."pauseReason"='quota_exhausted'
                OR r.failure->>'category' IN ('quota','subscription','api_key','access_denied') OR r.failure->>'code'='run_quota_exceeded'
                OR (r.status='paused' AND r."pauseReason" IS DISTINCT FROM 'human_control')) THEN NULL
          WHEN r."threadReplacedBy" IS NULL AND (r."awaitingApproval" OR (r.status='paused' AND r."pauseReason"='human_control')) THEN 'confirm'
          WHEN r."threadReplacedBy" IS NULL AND r.status='waiting_input' THEN 'needsReply'
          WHEN r."threadReplacedBy" IS NULL AND r.status IN ('queued','preparing','running','finishing','paused') THEN NULL
          WHEN r."threadReplacedBy" IS NULL AND r.outcome='needs_input' THEN 'needsReply'
          WHEN r."threadReplacedBy" IS NULL AND (r.status='failed' OR r.outcome='failed') THEN NULL
          WHEN i.status=$6 OR EXISTS(SELECT 1 FROM jsonb_array_elements(pull_requests.items) pr WHERE pr->>'state'=ANY($7::text[])) THEN 'review'
          WHEN r.id IS NULL AND shared.id IS NOT NULL THEN 'needsReply'
          WHEN r.id IS NULL OR r."threadReplacedBy" IS NOT NULL OR r.outcome IN ('done','idle') THEN NULL
          WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(pull_requests.items) pr WHERE pr->>'state'='merged') THEN NULL
          ELSE 'confirm' END AS reason) attention
        WHERE issue.metadata->>'deletedAt' IS NULL AND i."workspaceId"=$2 AND i."ownershipState"='bound'
          AND mikka_resource_acl_allowed('account', $1, i."workspaceId", 'task', i.id, 'canReadContent')
        UNION ALL
        SELECT s.id,'suggestion',s.source,coalesce(s."actionTitle",s.title),NULL::uuid,s."userId",s."occurredAt",false,
          (s."dismissedAt" IS NULL AND s."createdAt">now()-interval '7 days'),s."rejectedAt",s."rejectedBy",NULL::uuid,NULL::text,0 FROM suggestions s
        LEFT JOIN bots b ON b.id=s."botId" AND b."ownerId"=s."userId"
        WHERE s."userId"=$1 AND s.shown AND (b."workspaceId"=$2 OR (s."botId" IS NULL AND $3))
      ) SELECT s.*,z."snoozedUntil" FROM sources s LEFT JOIN inbox_snoozes z
        ON z."workspaceId"=$2 AND z."userId"=$1 AND z."itemType"=s.type AND z."itemId"=s.id
      WHERE ($4::text IS NULL OR s.type=$4) AND ($5::uuid IS NULL OR s.id=$5)
      `, values: [userId, workspaceId, scope.personal, type ?? null, id ?? null, TASK_REVIEW_STATUS, OPEN_TASK_PR_STATES, FACTORY_HANDOFF_STAGES] }
  }
  private async sources(tx: Pick<PoolClient, 'query'>, userId: string, workspaceId: string, scope: Scope, type?: string, id?: string) {
    return (await tx.query<SourceRow>(this.sourceQuery(userId, workspaceId, scope, type, id))).rows
  }

  async pendingCounts(reader: InboxReader, workspaceId: string) {
    const userId = typeof reader === 'string' ? reader : reader.id
    return this.guard(reader, workspaceId, async scope => {
      const source = this.sourceQuery(userId, workspaceId, scope)
      const { rows } = await this.pool.query<{ count: number; suggestionCount: number }>(
        `SELECT coalesce(sum(greatest("questionCount",1)) FILTER (WHERE type <> 'suggestion'), 0)::integer AS count,
                (count(*) FILTER (WHERE type = 'suggestion'))::integer AS "suggestionCount"
         FROM (${source.text}) eligible WHERE pending AND "snoozedUntil" IS NULL`, source.values)
      return rows[0]
    })
  }

  async list(reader: InboxReader, workspaceId: string, tab: 'pending' | 'done' | 'snoozed', limit: number, cursor?: string): Promise<InboxPage> {
    const userId = typeof reader === 'string' ? reader : reader.id
    return this.guard(reader, workspaceId, async scope => {
      const source = this.sourceQuery(userId, workspaceId, scope)
      const since = (await this.pool.query<{ historySince: Date }>('SELECT "historySince" FROM inbox_metadata')).rows[0].historySince.toISOString()
      const project = (s: SourceRow, done = false): InboxEntry => {
        const snoozedUntil = s.snoozedUntil?.toISOString() ?? null
        const status = done || !s.pending ? 'done' : snoozedUntil ? 'snoozed' : 'pending'
        const actions = status === 'done' ? s.rejectedAt ? ['undo_reject'] : []
          : [...(s.type === 'suggestion' ? ['accept', 'reject'] : ['open', ...(s.canReply ? ['reply'] : [])]), status === 'snoozed' ? 'reopen' : 'snooze']
        return { id: s.id, type: s.type, source: s.source, occurredAt: s.occurredAt.toISOString(), title: s.title, issueId: s.issueId, ownerId: s.ownerId,
          pending: s.pending, rejectedBy: s.rejectedBy ?? null, canReply: s.canReply ?? false, runId: s.runId ?? null, reason: s.reason ?? null, rejectedAt: s.rejectedAt?.toISOString() ?? null, status, snoozedUntil, actions }
      }
      if (tab !== 'done') {
        if (cursor && (!/^(task|suggestion):/.test(cursor) || !isInboxId(cursor.split(':')[1]))) throw new InboxError('inboxInvalid', 422)
        const { rows: items } = await this.pool.query<SourceRow>(`
          SELECT * FROM (${source.text}) eligible WHERE pending AND
            CASE WHEN $9::text='snoozed' THEN "snoozedUntil" IS NOT NULL ELSE "snoozedUntil" IS NULL END
            AND ($10::text IS NULL OR (type||':'||id)>$10) ORDER BY type,id LIMIT $11`, [...source.values, tab, cursor ?? null, limit + 1])
        return { items: items.slice(0, limit).map(s => project(s)), nextCursor: items.length > limit ? key(items[limit - 1].type, items[limit - 1].id) : null, historySince: since }
      }
      let after: { at: string; id: string } | null = null
      if (cursor) {
        try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch (error) { throw new InboxError('inboxInvalid', 422, { cause: error }) }
        if (!after || !/^\d{4}-\d{2}-\d{2}T/.test(after.at) || !Number.isFinite(Date.parse(after.at)) || !isInboxId(after.id)) throw new InboxError('inboxInvalid', 422)
      }
      // Authorization, history ordering and the page bound run in PostgreSQL;
      // the application never loads an account's entire task/history collection.
      const { rows } = await this.pool.query<SourceRow & { historyId: string; action: string; actorId: string; createdAt: Date; cursorAt: string; completionRunId: string | null }>(`
        WITH eligible AS (${source.text})
        SELECT s.*,h.id AS "historyId",h.action,h."actorId",h."createdAt",h."runId" AS "completionRunId",
          to_char(h."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorAt"
        FROM inbox_history h JOIN eligible s ON s.type=h."itemType" AND s.id=h."itemId"
        WHERE ($9::timestamptz IS NULL OR (h."createdAt",h.id)<($9::timestamptz,$10::uuid))
        ORDER BY h."createdAt" DESC,h.id DESC LIMIT $11`, [...source.values, after?.at ?? null, after?.id ?? null, limit + 1])
      const page = rows.slice(0, limit)
      return { items: page.map(row => ({ ...project(row, true), completion: { id: row.historyId, action: row.action, actorId: row.actorId, at: row.createdAt.toISOString(), runId: row.completionRunId } })),
        nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ at: page.at(-1)!.cursorAt, id: page.at(-1)!.historyId })).toString('base64url') : null, historySince: since }
    })
  }

  async command(reader: InboxReader, command: InboxCommand) {
    const userId = typeof reader === 'string' ? reader : reader.id
    const { workspaceId, type, id, action } = command
    if (action === 'snooze' && new Date(command.until).getTime() <= this.now().getTime()) throw new InboxError('inboxInvalid', 422)
    const result = await this.guard(reader, workspaceId, async scope => {
      const tx = await this.pool.connect()
      try {
        await tx.query('BEGIN')
        // All commands for the same inbox item serialize, including no-op replays.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([workspaceId, userId, type, id])])
        if (action === 'reject' || action === 'undo_reject') await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`attention:${userId}`])
        if (type === 'suggestion') await tx.query('SELECT id FROM suggestions WHERE id=$1 AND "userId"=$2 FOR UPDATE', [id, userId])
        const [item] = await this.sources(tx, userId, workspaceId, scope, type, id)
        if (!item) throw new InboxError('inboxNotFound', 404)
        let changed = false
        if (action === 'reject' || action === 'undo_reject') {
          if (type !== 'suggestion') throw new InboxError('inboxInvalid', 422)
          if (action === 'reject') {
            if (!item.pending && !item.rejectedAt) throw new InboxError('inboxConflict', 409)
            const rejected = await tx.query(`UPDATE suggestions SET "rejectedAt"=$3,"rejectedBy"=$2,"dismissedAt"=$3 WHERE id=$1 AND "userId"=$2 AND "dismissedAt" IS NULL RETURNING id`, [id, userId, this.now()])
            changed = Boolean(rejected.rowCount)
            if (changed) await tx.query(`INSERT INTO inbox_history(id,"itemType","itemId","ownerId","actorId",action,"sourceKey") VALUES($1,'suggestion',$2,$3,$3,'rejected',$4)`, [randomUUID(), id, userId, `reject:${randomUUID()}`])
          } else {
            const undone = await tx.query(`UPDATE suggestions SET "rejectedAt"=NULL,"rejectedBy"=NULL,"dismissedAt"=NULL WHERE id=$1 AND "userId"=$2 AND "rejectedAt" IS NOT NULL RETURNING id`, [id, userId])
            changed = Boolean(undone.rowCount)
          }
          if (changed && action === 'reject') {
            // A handoff already queued before rejection must not announce the
            // rejected item on the Coordinator's next turn. Share its writer lock.
            const matters = await tx.query<{ id: string }>(`UPDATE attention_matters SET state='quiet',reason='person_rejected_suggestion',"runAt"=NULL,recheck=false,"updatedAt"=now()
              WHERE "userId"=$1 AND "suggestionId"=$2 RETURNING id`, [userId, id])
            if (matters.rowCount) await tx.query(`UPDATE coordinator_events SET "deliveredAt"=now(),tier='background'
              WHERE "userId"=$1 AND kind='matter_handoff' AND "deliveredAt" IS NULL AND payload->>'matterId'=ANY($2::text[])`, [userId, matters.rows.map(m => m.id)])
          } else if (changed && action === 'undo_reject') {
            await tx.query(`UPDATE attention_matters SET state='waiting',reason=NULL,"updatedAt"=now() WHERE "userId"=$1 AND "suggestionId"=$2 AND state='quiet' AND reason='person_rejected_suggestion'`, [userId, id])
          }
          if (action === 'reject') await tx.query('DELETE FROM inbox_snoozes WHERE "workspaceId"=$1 AND "userId"=$2 AND "itemType"=$3 AND "itemId"=$4', [workspaceId, userId, type, id])
        } else if (action === 'snooze') {
          if (!item.pending) throw new InboxError('inboxConflict', 409)
          const saved = await tx.query(`INSERT INTO inbox_snoozes("workspaceId","userId","itemType","itemId","snoozedUntil") VALUES($1,$2,$3,$4,$5)
            ON CONFLICT("workspaceId","userId","itemType","itemId") DO UPDATE SET "snoozedUntil"=excluded."snoozedUntil" WHERE inbox_snoozes."snoozedUntil"<>excluded."snoozedUntil" RETURNING "itemId"`, [workspaceId, userId, type, id, command.until])
          changed = Boolean(saved.rowCount)
        } else {
          changed = Boolean((await tx.query('DELETE FROM inbox_snoozes WHERE "workspaceId"=$1 AND "userId"=$2 AND "itemType"=$3 AND "itemId"=$4 RETURNING "itemId"', [workspaceId, userId, type, id])).rowCount)
        }
        await tx.query('COMMIT')
        return { changed }
      } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    })
    if (result.changed) await this.changed(userId, workspaceId)
    if (action === 'snooze') await this.arm()
    return result
  }

  async nextDue() {
    const { rows } = await this.pool.query<{ at: Date | null }>('SELECT min("snoozedUntil") AS at FROM inbox_snoozes')
    return rows[0].at?.getTime() ?? null
  }
  async expire() {
    // Delete atomically, then publish committed invalidations. Concurrent due
    // timers cannot return the same persisted snooze twice.
    const tx = await this.pool.connect()
    let rows: { userId: string; workspaceId: string }[]
    try {
      await tx.query('BEGIN')
      rows = (await tx.query<{ userId: string; workspaceId: string }>('DELETE FROM inbox_snoozes WHERE "snoozedUntil"<=$1 RETURNING "userId","workspaceId"', [this.now()])).rows
      await tx.query('COMMIT')
    } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
    const scopes = new Map(rows.map(row => [JSON.stringify([row.userId, row.workspaceId]), row]))
    await Promise.all([...scopes.values()].map(row => this.changed(row.userId, row.workspaceId)))
    return this.nextDue()
  }
}
