import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { commandSchema, definitionSchema, ScheduleError, type Actor, type Definition, type ScheduledRead } from './contract'
import { nextTime, timezone } from './time'

export type WorkspaceGuard = <T>(ownerId: string, workspaceId: string | null, work: () => Promise<T>) => Promise<T>
export type MessageGuard = (tx: PoolClient, ownerId: string, value: unknown) => Promise<void>
export type IssueReader = (tx: PoolClient, ownerId: string, issueId: string) => Promise<{ id: string; title: string; status: string } | null>
export type Schedule = { id: string; owner_id: string; workspace_id: string | null; bot_id: string | null; source_event_id: string; definition: Definition; request_definition: Definition; status: string; version: number; next_at: Date | null }
export type Occurrence = { id: string; schedule_id: string; operation_id: string; event_id: string | null; definition: Definition; version: number; due_at: Date; status: string; attempts: number; lease_token: string | null; lease_until: Date; error: string | null; execution_decision: 'execute' | 'skip'; report_next_at: Date; report_attempts: number }
export const SCHEDULE_LEASE_MS = 5 * 60_000
const MAX_ATTEMPTS = 3

export function scheduledInbox(row: Occurrence | undefined, now: Date): { eventId: string; scope: ScheduledRead | null } | null {
  if(!row?.event_id)return null
  if(row.status!=='running'||!row.lease_token||row.lease_until<=now)return{eventId:row.event_id,scope:null}
  return{eventId:row.event_id,scope:{occurrenceId:row.id,leaseToken:row.lease_token,allowedActions:row.definition.task.kind==='agent_read'?row.definition.task.allowedActions:[],prompt:row.definition.task.kind==='agent_read'?row.definition.task.prompt:''}}
}


/** Definitions, due slots and original-chat publication share PostgreSQL commits.
 * Model reads use the existing inbox; no external write permission is created. */
export class ScheduleStore {
  constructor(private pool: Pool, private workspace: WorkspaceGuard, private issue: IssueReader, private safeMessage: MessageGuard, private agentAvailable: () => boolean, private clock: () => Date = () => new Date()) {}
  private async transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    const tx = await this.pool.connect()
    try { await tx.query('BEGIN'); await tx.query("SET LOCAL lock_timeout='5s'"); const value = await work(tx); await tx.query('COMMIT'); return value }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  private async conversation(tx: PoolClient, actor: Pick<Actor, 'ownerId' | 'workspaceId' | 'botId'>) {
    if (!(await tx.query('SELECT id FROM "user" WHERE id=$1 FOR SHARE', [actor.ownerId])).rowCount) throw new ScheduleError('scheduleOwnerUnavailable',403)
    if (actor.botId && !(await tx.query('SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR SHARE', [actor.botId,actor.ownerId,actor.workspaceId])).rowCount) throw new ScheduleError('scheduleConversationUnavailable',403)
  }
  private async source(tx: PoolClient, actor: Actor) {
    if (!actor.sourceEventId || !(await tx.query(`SELECT id FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid AND kind='user_message'`, [actor.sourceEventId,actor.ownerId,actor.botId])).rowCount) throw new ScheduleError('scheduleUserSourceRequired',403)
  }
  private async permission(tx: PoolClient, owner: string, def: Definition) {
    if(def.task.kind==='agent_read'&&!this.agentAvailable())throw new ScheduleError('scheduleAgentReadUnavailable',503)
    if (def.task.kind !== 'issue_snapshot') return null
    const issue = await this.issue(tx,owner,def.task.issueId)
    if (!issue) throw new ScheduleError('scheduleTaskAccessDenied',403)
    return issue
  }
  async command(actor: Actor, raw: unknown) {
    const parsed = commandSchema.safeParse(raw)
    if (!parsed.success) throw new ScheduleError('invalidScheduleCommand',400)
    const cmd = parsed.data
    return this.workspace(actor.ownerId,actor.workspaceId,()=>this.transaction(async tx=>{
      await this.conversation(tx,actor)
      await this.safeMessage(tx,actor.ownerId,cmd)
      if (cmd.action==='list') return { schedules:(await tx.query<Schedule>('SELECT * FROM user_schedules WHERE owner_id=$1 AND workspace_id IS NOT DISTINCT FROM $2::uuid AND bot_id IS NOT DISTINCT FROM $3::uuid ORDER BY created_at DESC LIMIT 100',[actor.ownerId,actor.workspaceId,actor.botId])).rows }
      if (cmd.action==='create') {
        await this.source(tx,actor)
        const def = definitionSchema.parse(cmd.definition); def.timezone = timezone(def.timezone)
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['schedule',actor.ownerId,actor.botId,cmd.requestId])])
        const old = (await tx.query<Schedule>('SELECT * FROM user_schedules WHERE owner_id=$1 AND bot_id IS NOT DISTINCT FROM $2::uuid AND request_id=$3',[actor.ownerId,actor.botId,cmd.requestId])).rows[0]
        if (old) { if (!isDeepStrictEqual(old.request_definition,def) || old.workspace_id!==actor.workspaceId) throw new ScheduleError('scheduleRequestConflict'); return { schedule:old,replayed:true } }
        await this.permission(tx,actor.ownerId,def)
        const next=nextTime(def,this.clock(),true)
        const {rows}=await tx.query<Schedule>(`INSERT INTO user_schedules(id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status,next_at) VALUES($1,$2,$3,$4,$5,$6,$7,$7,'active',$8) RETURNING *`,[randomUUID(),actor.ownerId,actor.workspaceId,actor.botId,actor.sourceEventId,cmd.requestId,def,next])
        return {schedule:rows[0],replayed:false}
      }
      const row=(await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1 AND owner_id=$2 AND workspace_id IS NOT DISTINCT FROM $3::uuid AND bot_id IS NOT DISTINCT FROM $4::uuid FOR UPDATE',[cmd.scheduleId,actor.ownerId,actor.workspaceId,actor.botId])).rows[0]
      if(!row) throw new ScheduleError('scheduleNotFound',404)
      if(cmd.action==='history') return {occurrences:(await tx.query('SELECT id,schedule_id,operation_id,event_id,version,due_at,status,attempts,result,error,started_at,finished_at,reported_at FROM schedule_occurrences WHERE schedule_id=$1 ORDER BY due_at DESC LIMIT 100',[row.id])).rows}
      await this.source(tx,actor)
      if(row.version!==cmd.version) throw new ScheduleError('scheduleVersionConflict')
      if(row.status==='cancelled') throw new ScheduleError('scheduleCancelled')
      let def=row.definition, status=row.status, next=row.next_at
      if(cmd.action==='update'){def=cmd.definition;def.timezone=timezone(def.timezone);await this.permission(tx,actor.ownerId,def);next=nextTime(def,this.clock(),true);if(status==='completed')status='active'}
      else if(cmd.action==='pause'){status='paused';next=null}
      else if(cmd.action==='cancel'){status='cancelled';next=null}
      else {if(status!=='paused')throw new ScheduleError('scheduleNotPaused');await this.permission(tx,actor.ownerId,def);next=nextTime(def,this.clock());status=next?'active':'completed'}
      const stale=await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status='cancelled',error='scheduleChanged',lease_token=NULL,lease_until=NULL,finished_at=$2 WHERE schedule_id=$1 AND status IN ('pending','running') RETURNING *`,[row.id,this.clock()])
      await this.lockChat(tx,row)
      for(const item of stale.rows){await this.retireEvent(tx,item.event_id);await this.report(tx,row,item,'cancelled',null,'scheduleChanged')}
      return {schedule:(await tx.query<Schedule>('UPDATE user_schedules SET definition=$2,status=$3,next_at=$4,version=version+1,updated_at=$5 WHERE id=$1 RETURNING *',[row.id,def,status,next,this.clock()])).rows[0]}
    }))
  }
  async materialize(limit=50){return this.transaction(async tx=>{
    const now=this.clock()
    const {rows}=await tx.query<Schedule>(`SELECT * FROM user_schedules WHERE status='active' AND next_at<=$1 ORDER BY next_at LIMIT $2 FOR UPDATE SKIP LOCKED`,[now,limit])
    for(const row of rows){const late=now.getTime()-row.next_at!.getTime()>row.definition.maxLatenessMinutes*60000;const skip=late&&row.definition.misfire==='skip';const next=nextTime(row.definition,now)
      await tx.query(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,operation_id,next_retry_at,execution_decision) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8) ON CONFLICT(schedule_id,version,due_at) DO NOTHING`,[randomUUID(),row.id,row.version,row.next_at,row.definition,randomUUID(),now,skip?'skip':'execute'])
      await tx.query('UPDATE user_schedules SET next_at=$2,status=$3,updated_at=$4 WHERE id=$1',[row.id,next,next?'active':'completed',now])
    } return rows.length
  })}
  async claim(){return this.transaction(async tx=>{
    const now=this.clock()
    const {rows}=await tx.query<Occurrence>(`WITH due AS(SELECT id FROM schedule_occurrences WHERE (status='pending' AND next_retry_at<=$1) OR(status='running' AND lease_until<=$1) ORDER BY next_retry_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE schedule_occurrences o SET status=CASE WHEN attempts >= 3 THEN 'failed' ELSE 'running' END,error=CASE WHEN attempts >= 3 THEN 'scheduleRecoveryExhausted' ELSE error END,finished_at=CASE WHEN attempts >= 3 THEN $1 ELSE finished_at END,lease_token=CASE WHEN attempts >= 3 THEN NULL ELSE $2::uuid END,lease_until=CASE WHEN attempts >= 3 THEN NULL ELSE $3::timestamptz END,attempts=LEAST(attempts+1,3),started_at=COALESCE(started_at,$1) FROM due WHERE o.id=due.id RETURNING o.*`,[now,randomUUID(),new Date(now.getTime()+SCHEDULE_LEASE_MS)])
    return rows[0]??null
  })}
  private async lockChat(tx:PoolClient,row:Schedule){await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`bot-chat:${row.owner_id}:${row.bot_id??'coordinator'}`])}
  private async retireEvent(tx:PoolClient,id:string|null){if(id)await tx.query(`UPDATE coordinator_events SET "deliveredAt"=COALESCE("deliveredAt",$2),tier='background' WHERE id=$1`,[id,this.clock()])}
  private async report(tx:PoolClient,row:Schedule,o:Occurrence,status:string,result:unknown,error:string|null,streamId?:string){
    const text=`[Schedule ${row.id}; occurrence ${o.id}; operation ${o.operation_id}] ${o.definition.title}: ${status}\n${result===null?error??'':typeof result==='object'&&result&&'text' in result?String(result.text):JSON.stringify(result)}`
    await this.safeMessage(tx,row.owner_id,text)
    await this.lockChat(tx,row)
    await tx.query(`INSERT INTO coordinator_messages(id,"userId","botId",position,message) SELECT $1,$2,$3,COALESCE(MAX(position),0)+1,$4 FROM coordinator_messages WHERE "userId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid ON CONFLICT(id) DO NOTHING`,[o.operation_id,row.owner_id,row.bot_id,{role:'assistant',content:text,...(streamId?{mikkaStreamId:streamId}:{})}])
    // A result is already in the chat. Whether it also needs the person (a failure, a skipped or cancelled run, a result they would want flagged)
    // is triage's call on the Decisions API, not a fixed background tier: the event is left untriaged and undelivered.
    await tx.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1,$2,$3,'run_report',$4,$5) ON CONFLICT("dedupeKey") DO NOTHING`,[o.id,row.owner_id,row.bot_id,`schedule_result:${o.id}`,{source:'schedule_result',scheduleId:row.id,occurrenceId:o.id,operationId:o.operation_id,status,error}])
    await tx.query('UPDATE schedule_occurrences SET reported_at=$2,report_attempts=report_attempts+1 WHERE id=$1',[o.id,this.clock()])
  }
  async execute(claim:Occurrence){
    const row=(await this.pool.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1',[claim.schedule_id])).rows[0]
    if(!row)return
    if(claim.status==='failed'){await this.transaction(async tx=>{await this.lockChat(tx,row);await this.retireEvent(tx,claim.event_id)});await this.publishFailedReport(claim);return}
    try{return await this.workspace(row.owner_id,row.workspace_id,()=>this.transaction(async tx=>{
      const current=(await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1 FOR UPDATE',[row.id])).rows[0]
      const o=(await tx.query<Occurrence>(`SELECT * FROM schedule_occurrences WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>$3 FOR UPDATE`,[claim.id,claim.lease_token,this.clock()])).rows[0]
      if(!o)return
      if(current.version!==o.version||['paused','cancelled'].includes(current.status))return
      await this.lockChat(tx,row)
      await this.retireEvent(tx,o.event_id)
      await this.conversation(tx,{ownerId:row.owner_id,workspaceId:row.workspace_id,botId:row.bot_id})
      if(o.attempts>MAX_ATTEMPTS)throw new ScheduleError('scheduleRecoveryExhausted')
      const skipped=o.execution_decision==='skip'
      const issue=skipped?null:await this.permission(tx,row.owner_id,o.definition)
      const task=o.definition.task
      if(!skipped&&task.kind==='agent_read'){
        const eventId=randomUUID()
        await tx.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,tier) VALUES($1,$2,$3,'run_report',$4,$5,'attention')`,[eventId,row.owner_id,row.bot_id,`schedule_due:${o.id}:${o.attempts}`,{source:'schedule_due',scheduleId:row.id,occurrenceId:o.id,text:task.prompt}])
        await tx.query('UPDATE schedule_occurrences SET event_id=$2 WHERE id=$1',[o.id,eventId])
        return row.owner_id
      }
      const result=skipped?null:task.kind==='reminder'?{text:task.text}:issue
      const status=skipped?'skipped':'succeeded'
      await tx.query('UPDATE schedule_occurrences SET status=$2,result=$3,error=$4,finished_at=$5,lease_token=NULL,lease_until=NULL WHERE id=$1',[o.id,status,result,skipped?'misfireSkipped':null,this.clock()])
      await this.report(tx,row,o,status,result,skipped?'misfireSkipped':null)
    }))}catch(error){await this.fail(claim,error)}
  }
  async fail(claim:Pick<Occurrence,'id'|'lease_token'>,error:unknown){
    const terminal=error instanceof ScheduleError&&(error.status===403||error.code==='scheduleRecoveryExhausted')
    const code=error instanceof ScheduleError?error.code:'scheduleExecutionUnavailable'
    const failed=await this.transaction(async tx=>{
      const row=(await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status=CASE WHEN $3 OR attempts >= $4 THEN 'failed' ELSE 'pending' END,error=$5,next_retry_at=$6,finished_at=CASE WHEN $3 OR attempts >= $4 THEN $7::timestamptz ELSE NULL END,lease_token=NULL,lease_until=NULL,report_next_at=$7 WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING *`,[claim.id,claim.lease_token,terminal,MAX_ATTEMPTS,code,new Date(this.clock().getTime()+30_000),this.clock()])).rows[0]
      if(row){const schedule=(await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1',[row.schedule_id])).rows[0];if(schedule)await this.lockChat(tx,schedule);await this.retireEvent(tx,row.event_id)}
      return row?.status==='failed'?row:null
    })
    if(failed)await this.publishFailedReport(failed)
  }
  private async publishFailedReport(o:Occurrence){
    const row=(await this.pool.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1',[o.schedule_id])).rows[0]
    if(!row)return
    const now=this.clock()
    try{await this.workspace(row.owner_id,row.workspace_id,()=>this.transaction(async tx=>{
      await tx.query('SELECT id FROM user_schedules WHERE id=$1 FOR UPDATE',[row.id])
      const current=(await tx.query<Occurrence>(`SELECT * FROM schedule_occurrences WHERE id=$1 AND status='failed' AND reported_at IS NULL AND report_next_at<=$2 FOR UPDATE SKIP LOCKED`,[o.id,now])).rows[0]
      if(current){await this.conversation(tx,{ownerId:row.owner_id,workspaceId:row.workspace_id,botId:row.bot_id});await this.report(tx,row,current,'failed',null,current.error)}
    }))}catch{await this.pool.query(`UPDATE schedule_occurrences SET report_attempts=report_attempts+1,report_next_at=$2::timestamptz+LEAST(21600,60*power(2,LEAST(report_attempts,9)))*interval '1 second' WHERE id=$1 AND status='failed' AND reported_at IS NULL AND report_next_at<=$2`,[o.id,now])}
  }
  async flushFailedReports(limit=50){for(const row of(await this.pool.query<Occurrence>(`SELECT * FROM schedule_occurrences WHERE status='failed' AND reported_at IS NULL AND report_next_at<=$2 ORDER BY report_next_at,finished_at,id LIMIT $1`,[limit,this.clock()])).rows)await this.publishFailedReport(row)}
  async tick(limit=50){await this.flushFailedReports(limit);const materialized=await this.materialize(limit);let executed=0;const started=performance.now();const wakeOwners=new Set<string>();for(;executed<limit&&performance.now()-started<5000;executed++){const claim=await this.claim();if(!claim)break;const owner=await this.execute(claim);if(owner)wakeOwners.add(owner)}return{materialized,executed,wakeOwners:[...wakeOwners]}}
  /** An event ID is accepted only through the persisted occurrence link. */
  async inbox(owner:string,botId:string|null,eventIds:readonly string[]):Promise<{eventId:string;scope:ScheduledRead|null}|null>{
    if(!eventIds.length)return null
    const {rows}=await this.pool.query<Occurrence&{owner_id:string;bot_id:string|null}>(`SELECT o.*,s.owner_id,s.bot_id FROM schedule_occurrences o JOIN user_schedules s ON s.id=o.schedule_id WHERE o.event_id=ANY($1::uuid[]) AND s.owner_id=$2 AND s.bot_id IS NOT DISTINCT FROM $3::uuid ORDER BY o.due_at,o.id LIMIT 1`,[eventIds,owner,botId])
    return scheduledInbox(rows[0],this.clock())
  }
  async assertRead(owner:string,botId:string|null,scope:ScheduledRead){
    const row=(await this.pool.query<Schedule&{occurrence_version:number;lease_token:string;lease_until:Date;occurrence_status:string;task:Definition['task']}>(`SELECT s.*,o.version occurrence_version,o.lease_token,o.lease_until,o.status occurrence_status,o.definition->'task' task FROM schedule_occurrences o JOIN user_schedules s ON s.id=o.schedule_id WHERE o.id=$1 AND s.owner_id=$2 AND s.bot_id IS NOT DISTINCT FROM $3::uuid`,[scope.occurrenceId,owner,botId])).rows[0]
    if(!row||row.occurrence_status!=='running'||row.lease_token!==scope.leaseToken||row.lease_until<=this.clock()||row.version!==row.occurrence_version||['paused','cancelled'].includes(row.status)||row.task.kind!=='agent_read'||!isDeepStrictEqual(row.task.allowedActions,scope.allowedActions)||row.task.prompt!==scope.prompt)throw new ScheduleError('scheduleReadAuthorityLost',403)
    await this.workspace(owner,row.workspace_id,()=>this.transaction(tx=>this.conversation(tx,{ownerId:owner,workspaceId:row.workspace_id,botId})))
  }
  async completeRead(owner:string,botId:string|null,scope:ScheduledRead,text:string,streamId?:string){
    await this.assertRead(owner,botId,scope)
    const row=(await this.pool.query<Schedule>('SELECT s.* FROM user_schedules s JOIN schedule_occurrences o ON o.schedule_id=s.id WHERE o.id=$1',[scope.occurrenceId])).rows[0]
    return this.workspace(owner,row.workspace_id,()=>this.transaction(async tx=>{
      await tx.query('SELECT id FROM user_schedules WHERE id=$1 FOR UPDATE',[row.id])
      await this.conversation(tx,{ownerId:owner,workspaceId:row.workspace_id,botId})
      const o=(await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status='succeeded',result=$3,finished_at=$4,lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>$4 RETURNING *`,[scope.occurrenceId,scope.leaseToken,{text},this.clock()])).rows[0]
      if(!o)throw new ScheduleError('scheduleReadAuthorityLost',403)
      await this.lockChat(tx,row)
      await this.retireEvent(tx,o.event_id)
      await this.report(tx,row,o,'succeeded',{text},null,streamId)
    }))
  }
}
