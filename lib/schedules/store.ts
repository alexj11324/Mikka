import { readIssueMetadata } from '../issue-metadata'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { commandSchema, definitionSchema, ScheduleError, type Actor, type Command, type Definition } from './contract'
import { nextTime, timezone } from './time'

export type WorkspaceGuard = <T>(ownerId: string, workspaceId: string, work: () => Promise<T>) => Promise<T>
type Schedule = {
  id: string; owner_id: string; workspace_id: string; conversation: 'bot' | 'coordinator'; session_id: string; source_id: string;
  definition: Definition; status: string; version: number; next_at: Date | null; request_id: string; request_definition: Definition
}
type Occurrence = { id: string; schedule_id: string; operation_id: string; definition: Definition; version: number; due_at: Date; status: string; attempts: number; lease_token: string; error: string | null }

/** Only transaction-local, read-only tasks are registered. Adding a provider
 * effect requires #208's stable operation ledger and domain approval checks. */
export class ScheduleStore {
  constructor(private pool: Pool, private workspace: WorkspaceGuard, private clock: () => Date = () => new Date(), private agent?: { enabled(): boolean; read(ownerId: string, task: Extract<Definition['task'], { kind: 'agent_read' }>, operationId: string): Promise<unknown> }) {}
  private async transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect()
    try { await tx.query('BEGIN'); await tx.query("SET LOCAL lock_timeout='5s'"); const result = await work(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  private async conversation(tx: PoolClient, actor: Pick<Actor, 'ownerId' | 'conversation' | 'sessionId'>) {
    const { rows } = await tx.query('SELECT id FROM "user" WHERE id=$1 FOR SHARE', [actor.ownerId])
    if (!rows.length) throw new ScheduleError('scheduleOwnerUnavailable', 403)
    if (actor.conversation === 'bot') {
      const session = await tx.query('SELECT id FROM agent_sessions WHERE id::text=$1 AND "userId"=$2 FOR SHARE', [actor.sessionId, actor.ownerId])
      if (!session.rows.length) throw new ScheduleError('scheduleConversationUnavailable', 403)
    } else if (actor.sessionId !== actor.ownerId) throw new ScheduleError('scheduleConversationUnavailable', 403)
  }
  private async source(tx: PoolClient, actor: Actor) {
    await this.conversation(tx, actor)
    const found = actor.conversation === 'bot'
      ? await tx.query('SELECT id FROM agent_turns WHERE id::text=$1 AND "sessionId"::text=$2 AND "userId"=$3', [actor.sourceId, actor.sessionId, actor.ownerId])
      : await tx.query(`SELECT id FROM coordinator_events WHERE id::text=$1 AND "userId"=$2 AND kind='user_message'`, [actor.sourceId, actor.ownerId])
    if (!found.rows.length) throw new ScheduleError('scheduleUserSourceRequired', 403)
  }
  private async taskPermission(tx: PoolClient, ownerId: string, def: Definition) {
    if (def.task.kind === 'agent_read' && !this.agent?.enabled()) throw new ScheduleError('scheduleAgentReadUnavailable', 403)
    if (def.task.kind === 'issue_snapshot') {
      // Match issue owner/member visibility, without granting future visibility.
      const { rows } = await tx.query(`SELECT i.id,i.title,i.status,i.content FROM issues i WHERE i.id=$1 AND (i."userId"=$2 OR EXISTS (SELECT 1 FROM issue_members m WHERE m."issueId"=i.id AND m."memberId"=$2)) FOR SHARE OF i`, [def.task.issueId, ownerId])
      if (!rows.length || readIssueMetadata(rows[0].content).deletedAt) throw new ScheduleError('scheduleTaskAccessDenied', 403)
      return rows[0] as { id: string; title: string; status: string; content: unknown }
    }
    return null
  }
  async command(actor: Actor, raw: Command | unknown) {
    const parsed = commandSchema.safeParse(raw)
    if (!parsed.success) throw new ScheduleError('invalidScheduleCommand', 400)
    const cmd = parsed.data
    return this.workspace(actor.ownerId, actor.workspaceId, () => this.transaction(async tx => {
      await this.conversation(tx, actor)
      if (cmd.action === 'list') return { schedules: (await tx.query('SELECT * FROM user_schedules WHERE owner_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT 100', [actor.ownerId, actor.workspaceId])).rows }
      if (cmd.action === 'create') {
        await this.source(tx, actor)
        const def = definitionSchema.parse(cmd.definition)
        def.timezone = timezone(def.timezone)
        const key = `${actor.ownerId}:${actor.workspaceId}:${cmd.requestId}`
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key])
        const old = (await tx.query<Schedule>('SELECT * FROM user_schedules WHERE owner_id=$1 AND workspace_id=$2 AND request_id=$3', [actor.ownerId, actor.workspaceId, cmd.requestId])).rows[0]
        if (old) {
          if (!isDeepStrictEqual(old.request_definition, def) || old.session_id !== actor.sessionId || old.conversation !== actor.conversation) throw new ScheduleError('scheduleRequestConflict')
          return { schedule: old, replayed: true }
        }
        await this.taskPermission(tx, actor.ownerId, def)
        const next = nextTime(def, this.clock(), true)
        const { rows } = await tx.query(`INSERT INTO user_schedules(id,owner_id,workspace_id,conversation,session_id,source_id,request_id,definition,request_definition,status,next_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,'active',$9) RETURNING *`, [randomUUID(), actor.ownerId, actor.workspaceId, actor.conversation, actor.sessionId, actor.sourceId, cmd.requestId, def, next])
        return { schedule: rows[0], replayed: false }
      }
      const row = (await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1 AND owner_id=$2 AND workspace_id=$3 FOR UPDATE', [cmd.scheduleId, actor.ownerId, actor.workspaceId])).rows[0]
      if (!row) throw new ScheduleError('scheduleNotFound', 404)
      if (cmd.action === 'history') return { occurrences: (await tx.query('SELECT * FROM schedule_occurrences WHERE schedule_id=$1 ORDER BY due_at DESC LIMIT 100', [row.id])).rows }
      await this.source(tx, actor)
      if (row.version !== cmd.version) throw new ScheduleError('scheduleVersionConflict')
      if (row.status === 'cancelled') throw new ScheduleError('scheduleCancelled')
      let def = row.definition
      let status = row.status
      let next = row.next_at
      if (cmd.action === 'update') {
        def = cmd.definition; def.timezone = timezone(def.timezone)
        await this.taskPermission(tx, actor.ownerId, def)
        next = nextTime(def, this.clock(), true)
        if (status === 'completed') status = 'active'
      } else if (cmd.action === 'pause') { status = 'paused'; next = null }
      else if (cmd.action === 'cancel') { status = 'cancelled'; next = null }
      else if (cmd.action === 'resume') {
        if (status !== 'paused') throw new ScheduleError('scheduleNotPaused')
        await this.taskPermission(tx, actor.ownerId, def)
        next = nextTime(def, this.clock()); status = next ? 'active' : 'completed'
      }
      // The same schedule lock fences due execution and every mutation. A
      // committed result precedes cancellation; a cancelled claim cannot execute.
      const stale = await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status='cancelled',error='scheduleChanged',lease_token=NULL,lease_until=NULL,finished_at=$2 WHERE schedule_id=$1 AND status IN ('pending','running') RETURNING *`, [row.id, this.clock()])
      for (const occurrence of stale.rows) await this.report(tx, row, occurrence, 'cancelled', null, 'scheduleChanged')
      const { rows } = await tx.query('UPDATE user_schedules SET definition=$2,status=$3,next_at=$4,version=version+1,updated_at=$5 WHERE id=$1 RETURNING *', [row.id, def, status, next, this.clock()])
      return { schedule: rows[0] }
    }))
  }
  /** Materialize at most one overdue slot per schedule per tick. catch_up_once
   * coalesces the backlog into this slot; skip records a skipped occurrence. */
  async materialize(limit = 50) {
    return this.transaction(async tx => {
      const now = this.clock()
      const { rows } = await tx.query<Schedule>(`SELECT * FROM user_schedules WHERE status='active' AND next_at<=$1 ORDER BY next_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit])
      for (const row of rows) {
        const occurrence = randomUUID()
        const late = now.getTime() - row.next_at!.getTime() > row.definition.maxLatenessMinutes * 60000
        const skipped = late && row.definition.misfire === 'skip'
        const next = nextTime(row.definition, now)
        const { rows: created } = await tx.query<Occurrence>(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,operation_id,next_retry_at,finished_at,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(schedule_id,version,due_at) DO NOTHING RETURNING *`, [occurrence, row.id, row.version, row.next_at, row.definition, skipped ? 'skipped' : 'pending', randomUUID(), now, skipped ? now : null, skipped ? 'misfireSkipped' : null])
        // Skipped history is persisted here. Delivery requires current permission
        // and is performed in claim/execute, never by an unguarded scanner.
        if (skipped && created.length) await tx.query(`UPDATE schedule_occurrences SET status='pending',error='misfireSkipped',finished_at=NULL WHERE id=$1`, [occurrence])
        await tx.query('UPDATE user_schedules SET next_at=$2,status=$3,updated_at=$4 WHERE id=$1', [row.id, next, next ? 'active' : 'completed', now])
      }
      return rows.length
    })
  }
  async claim() {
    return this.transaction(async tx => {
      const now = this.clock()
      const { rows } = await tx.query<Occurrence>(`WITH due AS (SELECT id FROM schedule_occurrences WHERE (status='pending' AND next_retry_at<=$1) OR (status='running' AND lease_until<=$1) ORDER BY next_retry_at LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE schedule_occurrences o SET status='running',lease_token=$2,lease_until=$3,attempts=attempts+1,started_at=COALESCE(started_at,$1) FROM due WHERE o.id=due.id RETURNING o.*`, [now, randomUUID(), new Date(now.getTime() + 60000)])
      return rows[0] ?? null
    })
  }
  private async report(tx: PoolClient, schedule: Schedule, occurrence: Occurrence, status: string, result: unknown, error: string | null) {
    const text = `[Schedule ${schedule.id}; occurrence ${occurrence.id}; operation ${occurrence.operation_id}] ${schedule.definition.title}: ${status}\n${result ? JSON.stringify(result) : error ?? ''}`
    if (schedule.conversation === 'bot') {
      await tx.query(`INSERT INTO agent_turns(id,"sessionId","userId",prompt,completion,status,"attemptId") VALUES($1,$2,$3,$4,$5,'complete',$1) ON CONFLICT(id) DO NOTHING`, [occurrence.operation_id, schedule.session_id, schedule.owner_id, `[Schedule] ${schedule.definition.title}`, text])
      await tx.query('UPDATE agent_sessions SET "updatedAt"=$2 WHERE id=$1', [schedule.session_id, this.clock()])
    } else {
      await tx.query('INSERT INTO coordinator_sessions("userId") VALUES($1) ON CONFLICT DO NOTHING', [schedule.owner_id])
      await tx.query('SELECT "userId" FROM coordinator_sessions WHERE "userId"=$1 FOR UPDATE', [schedule.owner_id])
      await tx.query(`INSERT INTO coordinator_messages(id,"userId",position,message) SELECT $1,$2,COALESCE(MAX(position),0)+1,$3 FROM coordinator_messages WHERE "userId"=$2 ON CONFLICT(id) DO NOTHING`, [occurrence.operation_id, schedule.owner_id, { role: 'assistant', content: text }])
    }
    // Existing inbox is the durable event/audit entry. The deterministic result
    // is already in its original chat; background tier avoids paid duplicate narration.
    await tx.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier) VALUES($1,$2,'schedule_result',$3,$4,'background') ON CONFLICT("dedupeKey") DO NOTHING`, [occurrence.id, schedule.owner_id, `schedule_result:${occurrence.id}`, { scheduleId: schedule.id, occurrenceId: occurrence.id, operationId: occurrence.operation_id, status, error }])
    await tx.query('UPDATE schedule_occurrences SET reported_at=$2 WHERE id=$1', [occurrence.id, this.clock()])
  }
  async execute(claim: Occurrence) {
    const schedule = (await this.pool.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1', [claim.schedule_id])).rows[0]
    if (!schedule) return
    try {
      await this.workspace(schedule.owner_id, schedule.workspace_id, () => this.transaction(async tx => {
        const row = (await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1 FOR UPDATE', [schedule.id])).rows[0]
        const occurrence = (await tx.query<Occurrence>(`SELECT * FROM schedule_occurrences WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>$3 FOR UPDATE`, [claim.id, claim.lease_token, this.clock()])).rows[0]
        if (!occurrence) return
        if (row.version !== occurrence.version || ['cancelled', 'paused'].includes(row.status)) {
          await tx.query(`UPDATE schedule_occurrences SET status='cancelled',finished_at=$2,lease_until=NULL,lease_token=NULL WHERE id=$1`, [claim.id, this.clock()]); return
        }
        if (occurrence.attempts > 3) throw new Error('scheduleLeaseRecoveryExhausted')
        await this.conversation(tx, { ownerId: row.owner_id, conversation: row.conversation, sessionId: row.session_id })
        const task = occurrence.definition.task
        const issue = await this.taskPermission(tx, row.owner_id, occurrence.definition)
        const skipped = occurrence.error === 'misfireSkipped'
        const result = skipped ? null : task.kind === 'reminder' ? { text: task.text } : task.kind === 'agent_read' ? await this.agent!.read(row.owner_id, task, occurrence.operation_id) : { issueId: issue!.id, title: issue!.title, status: issue!.status, checkedAt: this.clock().toISOString() }
        const status = skipped ? 'skipped' : 'succeeded'
        await tx.query(`UPDATE schedule_occurrences SET status=$2,result=$3,finished_at=$4,lease_token=NULL,lease_until=NULL WHERE id=$1`, [claim.id, status, result, this.clock()])
        await this.report(tx, row, occurrence, status, result, skipped ? 'misfireSkipped' : null)
      }))
    } catch (error) {
      // Read-only transaction rolled back: retrying cannot duplicate an external
      // effect. Permission failures stop immediately, operational failures cap at 3.
      const denied = error instanceof ScheduleError && error.status === 403
      const code = denied ? error.code : 'scheduleExecutionUnavailable'
      const failed = await this.transaction(async tx => {
        await tx.query('SELECT id FROM user_schedules WHERE id=$1 FOR UPDATE', [schedule.id])
        const { rows } = await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status=CASE WHEN $3 OR attempts>=3 THEN 'failed' ELSE 'pending' END,error=$4,next_retry_at=$5,finished_at=CASE WHEN $3 OR attempts>=3 THEN $6::timestamptz ELSE NULL END,lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING *`, [claim.id, claim.lease_token, denied, code, new Date(this.clock().getTime() + 30000 * 2 ** Math.min(claim.attempts - 1, 4)), this.clock()])
        return rows[0]?.status === 'failed' ? rows[0] : null

      })
      if (failed) {
        try { await this.workspace(schedule.owner_id, schedule.workspace_id, () => this.transaction(async tx => {
          await this.conversation(tx, { ownerId: schedule.owner_id, conversation: schedule.conversation, sessionId: schedule.session_id })
          await this.report(tx, schedule, failed, 'failed', null, code)
        })) } catch { /* Persisted failure remains available after reauthorization. */ }
      }
    }
  }
  /** Recover the commit-before-error-report crash window without another outbox. */
  async flushFailedReports(limit = 50) {
    const { rows } = await this.pool.query<{ id: string; schedule_id: string }>("SELECT id,schedule_id FROM schedule_occurrences WHERE status='failed' AND reported_at IS NULL ORDER BY finished_at LIMIT $1", [limit])
    for (const entry of rows) {
      const schedule = (await this.pool.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1', [entry.schedule_id])).rows[0]
      try { await this.workspace(schedule.owner_id, schedule.workspace_id, () => this.transaction(async tx => {
        await tx.query('SELECT id FROM user_schedules WHERE id=$1 FOR UPDATE', [schedule.id])
        const occurrence = (await tx.query<Occurrence>("SELECT * FROM schedule_occurrences WHERE id=$1 AND reported_at IS NULL AND status='failed' FOR UPDATE", [entry.id])).rows[0]
        if (!occurrence) return
        await this.conversation(tx, { ownerId: schedule.owner_id, conversation: schedule.conversation, sessionId: schedule.session_id })
        await this.report(tx, schedule, occurrence, 'failed', null, occurrence.error)
      })) } catch { /* Current revocation keeps history private until reauthorization. */ }
    }
  }
  async tick(limit = 50) {
    await this.flushFailedReports(limit)
    const materialized = await this.materialize(limit)
    let executed = 0
    const started = performance.now()
    for (; executed < limit && performance.now() - started < 5000; executed++) { const claim = await this.claim(); if (!claim) break; await this.execute(claim) }
    return { materialized, executed }
  }
}
