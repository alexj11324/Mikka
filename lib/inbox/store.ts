import type { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { InboxError, isInboxId, type InboxCommand, type InboxSource, type InboxPage, type InboxEntry } from './contract'

export type Scope = { personal: boolean; issueIds: string[]; otherIssueIds: string[] }
export type Guard = <T>(userId: string, workspaceId: string, work: (scope: Scope) => Promise<T>) => Promise<T>
export type Changed = (userId: string, workspaceId: string) => Promise<void>
type SourceRow = InboxSource & { snoozedUntil: Date | null }
const key = (type: string, id: string) => `${type}:${id}`

/** The source's own authority is checked on every read/write. Snooze is per
 * viewer, so it never changes a teammate's task or grants execution authority. */
export class InboxStore {
  constructor(readonly pool: Pool, readonly guard: Guard, readonly changed: Changed, readonly arm: () => Promise<void>, readonly now = () => new Date()) {}

  private sourceQuery(userId: string, workspaceId: string, scope: Scope, type?: string, id?: string) {
    return { text: `
      WITH sources AS (
        SELECT i.id,'task' AS type,'agent' AS source,i.title,i.id AS "issueId",i."userId" AS "ownerId",
          (r."userId"=$1) AS "canReply",
          CASE WHEN i.status IN ('done','canceled','duplicate') THEN false
            WHEN EXISTS(SELECT 1 FROM factory_tasks f WHERE f."issueId"=i.id AND f.stage='approval' AND f.status IN ('pending','waiting')) THEN true
            WHEN r.id IS NULL OR r.status IN ('queued','preparing','running','finishing','paused') THEN false
            WHEN r.status='waiting_input' THEN true
            WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(i.content->'attrs'->'mikka'->'pullRequests','[]'::jsonb)) pr WHERE pr->>'state'='merged') THEN false
            WHEN r.outcome IN ('failed','blocked') THEN false
            WHEN i.status='review' THEN true
            WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(i.content->'attrs'->'mikka'->'pullRequests','[]'::jsonb)) pr WHERE pr->>'state' IN ('open','draft')) THEN true
            WHEN r.outcome IN ('done','idle') THEN false
            ELSE r.status<>'failed' END AS pending,
          NULL::timestamptz AS "rejectedAt", NULL::text AS "rejectedBy", r.id AS "runId",
          CASE WHEN r.status='waiting_input' OR r.outcome='needs_input' THEN 'needsReply'
            WHEN i.status='review' OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(i.content->'attrs'->'mikka'->'pullRequests','[]'::jsonb)) pr WHERE pr->>'state' IN ('open','draft')) OR EXISTS(SELECT 1 FROM factory_tasks f WHERE f."issueId"=i.id AND f.stage='approval' AND f.status IN ('pending','waiting')) THEN 'review'
            ELSE 'confirm' END AS reason
        FROM issues i LEFT JOIN LATERAL (SELECT id,"userId",status,outcome FROM agent_runs WHERE "issueId"=i.id ORDER BY "createdAt" DESC,id DESC LIMIT 1) r ON true
        WHERE coalesce(i.content->'attrs'->'mikka',i.content->'attrs'->'orvilo')->>'deletedAt' IS NULL
          AND ((i.scope='workspace' AND i.id=ANY($3::uuid[])) OR ($4 AND i."userId"=$1 AND NOT (i.scope='workspace' AND i.id=ANY($5::uuid[]))))
        UNION ALL
        SELECT s.id,'suggestion',s.source,coalesce(s."actionTitle",s.title),NULL::uuid,s."userId",false,
          (s."dismissedAt" IS NULL AND s."createdAt">now()-interval '7 days'),s."rejectedAt",s."rejectedBy",NULL::uuid,NULL::text FROM suggestions s
        LEFT JOIN bots b ON b.id=s."botId" AND b."ownerId"=s."userId"
        WHERE s."userId"=$1 AND s.shown AND (b."workspaceId"=$2 OR (s."botId" IS NULL AND $4))
      ) SELECT s.*,z."snoozedUntil" FROM sources s LEFT JOIN inbox_snoozes z
        ON z."workspaceId"=$2 AND z."userId"=$1 AND z."itemType"=s.type AND z."itemId"=s.id
      WHERE ($6::text IS NULL OR s.type=$6) AND ($7::uuid IS NULL OR s.id=$7)
      `, values: [userId, workspaceId, scope.issueIds, scope.personal, scope.otherIssueIds, type ?? null, id ?? null] }
  }
  private async sources(tx: Pick<PoolClient, 'query'>, userId: string, workspaceId: string, scope: Scope, type?: string, id?: string) {
    return (await tx.query<SourceRow>(this.sourceQuery(userId, workspaceId, scope, type, id))).rows
  }

  async list(userId: string, workspaceId: string, tab: 'pending' | 'done' | 'snoozed', limit: number, cursor?: string): Promise<InboxPage> {
    return this.guard(userId, workspaceId, async scope => {
      const source = this.sourceQuery(userId, workspaceId, scope)
      const since = (await this.pool.query<{ historySince: Date }>('SELECT "historySince" FROM inbox_metadata')).rows[0].historySince.toISOString()
      const project = (s: SourceRow, done = false): InboxEntry => {
        const snoozedUntil = s.snoozedUntil?.toISOString() ?? null
        const status = done || !s.pending ? 'done' : snoozedUntil ? 'snoozed' : 'pending'
        const actions = status === 'done' ? s.rejectedAt ? ['undo_reject'] : []
          : [...(s.type === 'suggestion' ? ['accept', 'reject'] : ['open', ...(s.canReply ? ['reply'] : [])]), status === 'snoozed' ? 'reopen' : 'snooze']
        return { id: s.id, type: s.type, source: s.source, title: s.title, issueId: s.issueId, ownerId: s.ownerId,
          pending: s.pending, rejectedBy: s.rejectedBy ?? null, canReply: s.canReply ?? false, runId: s.runId ?? null, reason: s.reason ?? null, rejectedAt: s.rejectedAt?.toISOString() ?? null, status, snoozedUntil, actions }
      }
      if (tab !== 'done') {
        if (cursor && (!/^(task|suggestion):/.test(cursor) || !isInboxId(cursor.split(':')[1]))) throw new InboxError('inboxInvalid', 422)
        const { rows: items } = await this.pool.query<SourceRow>(`
          SELECT * FROM (${source.text}) eligible WHERE pending AND
            CASE WHEN $8::text='snoozed' THEN "snoozedUntil" IS NOT NULL ELSE "snoozedUntil" IS NULL END
            AND ($9::text IS NULL OR (type||':'||id)>$9) ORDER BY type,id LIMIT $10`, [...source.values, tab, cursor ?? null, limit + 1])
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
        WHERE ($8::timestamptz IS NULL OR (h."createdAt",h.id)<($8::timestamptz,$9::uuid))
        ORDER BY h."createdAt" DESC,h.id DESC LIMIT $10`, [...source.values, after?.at ?? null, after?.id ?? null, limit + 1])
      const page = rows.slice(0, limit)
      return { items: page.map(row => ({ ...project(row, true), completion: { id: row.historyId, action: row.action, actorId: row.actorId, at: row.createdAt.toISOString(), runId: row.completionRunId } })),
        nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ at: page.at(-1)!.cursorAt, id: page.at(-1)!.historyId })).toString('base64url') : null, historySince: since }
    })
  }

  async command(userId: string, command: InboxCommand) {
    const { workspaceId, type, id, action } = command
    if (action === 'snooze' && new Date(command.until).getTime() <= this.now().getTime()) throw new InboxError('inboxInvalid', 422)
    const result = await this.guard(userId, workspaceId, async scope => {
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
