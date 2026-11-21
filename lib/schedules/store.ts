import type { CancelledAutomationRun, WebhookBatch, WebhookBatchClosure } from './automation-view'
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { issues } from '../db/schema'
import { issueVisibilityPredicate } from '../issue-visibility-policy'
import { commandSchema, definitionSchema, ScheduleError, SCHEDULE_PAGE_MAX, type Actor, type Command, type Definition, type DispatchTask, type EventTrigger, type ScheduledRead } from './contract'
import { describeGitHubEvent, triggerMatches, type GitHubAutomationEvent } from './github-events'
import { describeLinearEvent, linearTriggerMatches, type LinearAutomationEvent } from './linear-events'
import { describeSlackEvent, slackTriggerMatches, type SlackAutomationEvent } from './slack-events'
import { describeWebhook, newWebhookKey, webhookKeyHash, WEBHOOK_BATCH_BYTES, WEBHOOK_BATCH_REQUESTS, type WebhookRequest } from './webhook'
import { nextTime, runsOnSchedule, timezone } from './time'
import { botChatChanged } from '../live/chats'
import { observePoolCommits } from '../db/commit-effects'
import { coordinatorSessionChanged } from '../live/coordinator-session'
import { wakeCoordinatorAfterCommit } from '../coordinator/wake-after-commit'
import { scheduleChatMessage } from './chat-result'
import { ACTION_ERROR_CODES } from '../action-result'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type WorkspaceAccess = { role: 'owner' | 'admin' | 'member'; requireActiveMember?: (userId: string) => Promise<void> }
export type WorkspaceGuard = <T>(ownerId: string, workspaceId: string | null, work: (access: WorkspaceAccess) => Promise<T>) => Promise<T>
export type MessageGuard = (tx: PoolClient, ownerId: string, value: unknown) => Promise<void>
export type IssueReader = (tx: PoolClient, ownerId: string, issueId: string) => Promise<{ id: string; title: string; status: string } | null>
/** What one dispatch_task run made: the task (as the chat's task line shows it) and the request event behind it. */
export type DispatchResult = { id: string; title: string; status: string; identifier: string | null; eventId?: string; requestedBy?: string; runId?: string; continued?: true }
/** How each run is set up beyond the request: the Environment, model and effort, machine size and the thread's organize. */
export type DispatchRun = Pick<Definition, 'environmentId' | 'model' | 'machineSize' | 'runs'>
export type DispatchInput = { ownerId: string; workspaceId: string; scheduleId: string; occurrenceId: string; task: DispatchTask; event?: string; source?: 'github' | 'linear' | 'slack' | 'webhook'; single?: true; thread?: string; run?: DispatchRun }
/** What started a run: a GitHub event and the indexes of the triggers that took it, or the webhook requests it batched. */
export type OccurrenceTrigger = { event: GitHubAutomationEvent | LinearAutomationEvent | SlackAutomationEvent; triggers: number[] } | { webhook: { requests: WebhookRequest[] } }
/** One finished run to post: the automation, how it ended, and the task it made or added to. */
export type RunNotice = { ownerId: string; workspaceId: string; scheduleId: string; title: string; channel: string; locale: 'zh-CN' | 'en'; status: 'succeeded' | 'failed'; task: { id: string; identifier: string | null; title: string } | null; error: string | null
  /** Post with the run-as person's name and picture; quiet is one plain line. `ownerId` is that person. */
  postAsRunner?: true; quiet?: true }
export type RunWhenInput = { ownerId: string; workspaceId: string; condition: string; event: string }
/**
 * dispatch_task's two host seams. `check` re-authorizes the creator's request at create, update, resume and every run
 * (403 when it no longer holds: the run fails and says so). `dispatch` creates and hands over the task through the
 * ordinary 创建并派发 path; it is idempotent per occurrence. `changed` publishes the workspace's schedule list.
 */
export type AutomationSeams = {
  check?: (tx: PoolClient, ownerId: string, workspaceId: string, task: DispatchTask) => Promise<void>
  dispatch?: (input: DispatchInput) => Promise<DispatchResult>
  changed?: (tx: PoolClient, workspaceId: string) => Promise<void>
  /** The Linear team IDs the person's own Linear connection can see, or null without one. */
  linearTeams?: (ownerId: string) => Promise<Set<string> | null>
  /** 运行后发到 Slack: post a finished run to the channel, as the workspace's Slack app. */
  notify?: (input: RunNotice) => Promise<void>
  /** The channel IDs the workspace's Slack installation can see for the person, or null when they are not in it. */
  slackChannels?: (ownerId: string, workspaceId: string) => Promise<Set<string> | null>
  /** Whether the workspace can still use a repository an event trigger names. */
  repository?: (workspaceId: string, repository: string) => Promise<boolean>
  /** Whether the workspace still has this Environment, not archived. */
  environment?: (workspaceId: string, environmentId: string) => Promise<boolean>
  /** Whether the person may still send to this thread (its root run) in the workspace. */
  thread?: (ownerId: string, workspaceId: string, threadId: string) => Promise<boolean>
  /** The person's Coordinator chat in a workspace, which a page-made automation reports to; null without one. */
  chat?: (ownerId: string, workspaceId: string) => Promise<string | null>
  /** A trigger's one-sentence condition against the event: true, false, or null when no answer could be had. */
  runWhen?: (input: RunWhenInput) => Promise<boolean | null>
}
export type Schedule = { id: string; owner_id: string; run_as_user_id?: string | null; workspace_id: string | null; bot_id: string | null; visibility: 'owner' | 'workspace'; source_event_id: string; definition: Definition; request_definition: Definition; status: string; deleted?: boolean; status_before_delete?: 'active' | 'paused' | 'completed' | null; version: number; next_at: Date | null; disabled_reason?: string | null }
export type Occurrence = { id: string; schedule_id: string; operation_id: string; event_id: string | null; definition: Definition; version: number; due_at: Date; status: string; attempts: number; lease_token: string | null; lease_until: Date; error: string | null; execution_decision: 'execute' | 'skip'; trigger: OccurrenceTrigger | null; report_next_at: Date; report_attempts: number; started_at: Date | null; created_at: Date }
// The newest admitted batch supersedes older windows, even after someone closes it early.
const WEBHOOK_BATCH = `trigger ? 'webhook' AND (definition#>>'{webhook,batchMinutes}')::int > 0 AND NOT (status='skipped' AND attempts=0)`
// Canceled historical batches may have already erased their payloads. Their byte count is unknown.
const WEBHOOK_BODY_BYTES = `(SELECT CASE WHEN count(item->>'body')=count(*)
  THEN COALESCE(sum(octet_length(item->>'body')),0)::int END
  FROM jsonb_array_elements(trigger#>'{webhook,requests}') AS item)`
const OPEN_WEBHOOK_WINDOW = `FROM schedule_occurrences
  WHERE id=(SELECT id FROM schedule_occurrences WHERE schedule_id=$1 AND version=$2 AND ${WEBHOOK_BATCH}
    ORDER BY due_at DESC,id DESC LIMIT 1)
    AND status='pending' AND attempts=0 AND next_retry_at>statement_timestamp()`
const COLLECTING_WINDOW = `SELECT id ${OPEN_WEBHOOK_WINDOW}
  AND jsonb_array_length(trigger->'webhook'->'requests')<${WEBHOOK_BATCH_REQUESTS} AND octet_length(trigger::text)<=${WEBHOOK_BATCH_BYTES}`
// Both history and mutation receipts use this allowlist. Sender input and deduplication keys stay in storage.
const WEBHOOK_BATCH_COLUMNS = `id, schedule_id AS "automationId", created_at, due_at, status AS "runStatus",
  jsonb_array_length(trigger#>'{webhook,requests}') AS "requestCount",
  jsonb_array_length(trigger#>'{webhook,requests}') AS "eventCount",
  trigger#>>'{webhook,requests,0,at}' AS "firstEventAt", trigger#>>'{webhook,requests,-1,at}' AS "lastEventAt",
  COALESCE((trigger#>>'{webhook,byteCount}')::int, ${WEBHOOK_BODY_BYTES}) AS "byteCount",
  CASE WHEN attempts>0 OR trigger#>>'{webhook,closedBy}'='flush_batch' THEN id END AS "runId",
  CASE WHEN status='failed' THEN error END AS failure,
  '[]'::jsonb AS "group", NULL::int AS "quietPeriodSeconds",
  ${WEBHOOK_BATCH_REQUESTS} AS "maxEvents", (definition#>>'{webhook,batchMinutes}')::int * 60 AS "maxWaitSeconds",
  CASE WHEN trigger#>>'{webhook,closedBy}'='flush_batch' THEN (trigger#>>'{webhook,closedAt}')::timestamptz
    ELSE due_at END AS "dispatchAfter",
  COALESCE((trigger#>>'{webhook,closedAt}')::timestamptz, CASE WHEN trigger#>>'{webhook,closedBy}'='cancel_batch' THEN finished_at END) AS "closedAt",
  CASE trigger#>>'{webhook,closedBy}' WHEN 'cancel_batch' THEN 'cancelled' WHEN 'flush_batch' THEN 'manual' END AS reason,
  CASE WHEN status='cancelled' THEN 'cancelled' WHEN id=(${COLLECTING_WINDOW}) THEN 'collecting' ELSE 'queued' END AS status`
// Background recovery also uses scheduler-only codes outside the public action catalogue.
const batchFailureCodes = new Set<string>([...ACTION_ERROR_CODES, 'scheduleRecoveryExhausted', 'scheduleExecutionUnavailable'])
function publicBatch(record: WebhookBatch): WebhookBatch {
  return record.failure && !batchFailureCodes.has(record.failure) ? { ...record, failure: null } : record
}
// A pending retry may already have dispatched. Collection windows have a separate batch lifecycle.
const cancellableRun = `status='pending' AND attempts=0 AND lease_token IS NULL AND event_id IS NULL
  AND NOT (COALESCE(trigger ? 'webhook', false) AND COALESCE((definition#>>'{webhook,batchMinutes}')::int,0)>0)`
export const SCHEDULE_LEASE_MS = 5 * 60_000
const MAX_ATTEMPTS = 3
// The frozen request key is internal; keep the existing tool-response fields.
const SCHEDULE_COLUMNS = 'id,owner_id,run_as_user_id,workspace_id,bot_id,visibility,source_event_id,request_id,definition,request_definition,status,status_before_delete IS NOT NULL AS deleted,version,next_at,disabled_reason,webhook_key_hash IS NOT NULL AS webhook_key_set,folder,tags,created_at,updated_at'
/** A run that fails one of these lost its creator's authority: the automation is paused with the code as its reason. */
const AUTHORITY_LOST = new Set(['scheduleStandingTaskUnavailable','scheduleWorkspaceAccessDenied','scheduleOwnerUnavailable','scheduleConversationUnavailable','scheduleBotUnavailable','scheduleRepositoryUnavailable','scheduleLinearUnavailable','scheduleSlackUnavailable','scheduleDeviceUnavailable','scheduleProfileUnavailable','scheduleEnvironmentUnavailable','scheduleThreadUnavailable','scheduleRunAsUnavailable'])
/** Runs that count toward maxRunsPerDay: queued, running and finished, not skipped or cancelled. */
const COUNTED = "status IN ('pending','running','succeeded','failed')"

/** The earliest persisted due time of any schedule work (epoch ms, rounded up from PostgreSQL microseconds), or null. */
/** Each persisted due time of schedule work, as rows of `at` (no parameters). */
export const SCHEDULE_DUE_SQL=`SELECT min(next_at) AS at FROM user_schedules WHERE status='active'
    UNION ALL SELECT min(next_retry_at) FROM schedule_occurrences WHERE status='pending'
    UNION ALL SELECT min(lease_until) FROM schedule_occurrences WHERE status='running'
    UNION ALL SELECT min(report_next_at) FROM schedule_occurrences WHERE status='failed' AND reported_at IS NULL
    UNION ALL SELECT min("snoozedUntil") FROM inbox_snoozes
    UNION ALL SELECT min("snoozedUntil") FROM inbox_conversation_snoozes`
export async function nextScheduleDue(executor:Pick<Pool,'query'>):Promise<number|null>{
  const {rows}=await executor.query<{at:string|null}>(`SELECT ceil(extract(epoch FROM min(at))*1000)::bigint::text AS at FROM (${SCHEDULE_DUE_SQL}) due`)
  return rows[0]?.at==null?null:Number(rows[0].at)
}

export function scheduledInbox(row: Occurrence | undefined, now: Date): { eventId: string; scope: ScheduledRead | null } | null {
  if(!row?.event_id)return null
  if(row.status!=='running'||!row.lease_token||row.lease_until<=now)return{eventId:row.event_id,scope:null}
  return{eventId:row.event_id,scope:{occurrenceId:row.id,leaseToken:row.lease_token,allowedActions:row.definition.task.kind==='agent_read'?row.definition.task.allowedActions:[],prompt:row.definition.task.kind==='agent_read'?row.definition.task.prompt:''}}
}


/** Definitions, due slots and original-chat publication share PostgreSQL commits.
 * Model reads use the existing inbox; no external write permission is created. */
export class ScheduleStore {
  constructor(private pool: Pool, private workspace: WorkspaceGuard, private issue: IssueReader, private safeMessage: MessageGuard, private agentAvailable: (ownerId: string, botId: string | null) => boolean | Promise<boolean>, private clock: () => Date = () => new Date(), private automation: AutomationSeams = {}) {}
  private async listChanged(tx: PoolClient, workspaceId: string | null) { if (workspaceId) await this.automation.changed?.(tx, workspaceId) }
  private async transaction<T>(work: (tx: PoolClient) => Promise<T>): Promise<T> {
    observePoolCommits(this.pool)
    const tx = await this.pool.connect()
    try { await tx.query('BEGIN'); await tx.query("SET LOCAL lock_timeout='5s'"); const value = await work(tx); await tx.query('COMMIT'); return value }
    catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  private async conversation(tx: PoolClient, actor: Pick<Actor, 'ownerId' | 'workspaceId' | 'botId'>) {
    if (!(await tx.query('SELECT id FROM "user" WHERE id=$1 FOR SHARE', [actor.ownerId])).rowCount) throw new ScheduleError('scheduleOwnerUnavailable',403)
    if (actor.botId && !(await tx.query('SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR SHARE', [actor.botId,actor.ownerId,actor.workspaceId])).rowCount) throw new ScheduleError('scheduleConversationUnavailable',403)
  }
  /**
   * Runs as: who a dispatched task runs, is billed and posts as — the named member, else the creator. The named person
   * must still be an active member of the workspace; a person who is not stops the automation with that reason.
   */
  private async runner(access: WorkspaceAccess, row: Pick<Schedule, 'owner_id' | 'run_as_user_id'>, def: Definition) {
    const runAs = def.task.kind === 'dispatch_task' ? row.run_as_user_id ?? null : null
    if (!runAs || runAs === row.owner_id) return row.owner_id
    if (!access.requireActiveMember) throw new ScheduleError('scheduleRunAsUnavailable', 403)
    try { await access.requireActiveMember(runAs) } catch (error) { throw new ScheduleError('scheduleRunAsUnavailable', 403, { cause: error }) }
    return runAs
  }
  /**
   * While an automation runs as someone else, only that person or an owner/admin may start or resume its runs: what it
   * spends and acts with is theirs.
   */
  private consented(actor: Actor, access: WorkspaceAccess, row: Pick<Schedule, 'run_as_user_id'>) {
    if (row.run_as_user_id && row.run_as_user_id !== actor.ownerId && access.role === 'member') throw new ScheduleError('scheduleRunAsConsentRequired', 403)
  }
  /** Posting under a person's name and picture is turned on only by that person (the run-as person, else the creator). */
  private postAsConsented(actor: Actor, before: Pick<Schedule, 'owner_id' | 'run_as_user_id' | 'definition'>, def: Definition, runner: string) {
    if (!def.notify?.slack?.postAsRunner || actor.ownerId === runner) return
    const kept = before.definition.notify?.slack?.postAsRunner === true && (before.run_as_user_id ?? before.owner_id) === runner
    if (!kept) throw new ScheduleError('scheduleRunAsConsentRequired', 403)
  }
  private async source(tx: PoolClient, actor: Actor, workspaceId: string | null) {
    // The 自动化 page's server action authenticated the person; a chat command names their message instead.
    if (actor.direct) return
    if (!actor.sourceEventId || !(await tx.query(`SELECT 1 FROM coordinator_events e LEFT JOIN bots b ON b.id=e."botId" WHERE e.id=$1 AND e."userId"=$2 AND e.kind='user_message' AND (e."botId" IS NULL OR b."workspaceId" IS NOT DISTINCT FROM $3::uuid)`,[actor.sourceEventId,actor.ownerId,workspaceId])).rowCount) throw new ScheduleError('scheduleUserSourceRequired',403)
  }
  private async permission(tx: PoolClient, owner: string, botId: string | null, workspaceId: string | null, def: Definition) {
    if(def.task.kind==='agent_read'&&!await this.agentAvailable(owner,botId))throw new ScheduleError('scheduleAgentReadUnavailable',503)
    if(def.task.kind==='dispatch_task'){
      if(!workspaceId||!this.automation.check)throw new ScheduleError('scheduleDispatchUnavailable',503)
      await this.automation.check(tx,owner,workspaceId,def.task)
      if(def.environmentId&&(!this.automation.environment||!await this.automation.environment(workspaceId,def.environmentId)))throw new ScheduleError('scheduleEnvironmentUnavailable',403)
      if(def.singleThreadId&&(!this.automation.thread||!await this.automation.thread(owner,workspaceId,def.singleThreadId)))throw new ScheduleError('scheduleThreadUnavailable',403)
      for(const repository of new Set((def.events??[]).flatMap(trigger=>trigger.source==='github'?trigger.repositories:[]))){
        if(!this.automation.repository||!await this.automation.repository(workspaceId,repository))throw new ScheduleError('scheduleRepositoryUnavailable',403)
      }
      const teams=new Set((def.events??[]).flatMap(trigger=>trigger.source==='linear'?trigger.teams:[]))
      if(teams.size){
        // A Linear trigger names teams the creator's own Linear connection can see.
        const visible=this.automation.linearTeams?await this.automation.linearTeams(owner):null
        if(!visible||[...teams].some(team=>!visible.has(team)))throw new ScheduleError('scheduleLinearUnavailable',403)
      }
      const channels=new Set([...(def.events??[]).flatMap(trigger=>trigger.source==='slack'?trigger.channels:[]),...(def.notify?.slack?[def.notify.slack.channel]:[])])
      if(channels.size){
        // A Slack trigger names channels of the workspace's Slack installation, which the creator is a member of.
        const visible=this.automation.slackChannels?await this.automation.slackChannels(owner,workspaceId):null
        if(!visible||[...channels].some(channel=>!visible.has(channel)))throw new ScheduleError('scheduleSlackUnavailable',403)
      }
      return null
    }
    if (def.task.kind !== 'issue_snapshot') return null
    const issue = await this.issue(tx,owner,def.task.issueId)
    if (!issue) throw new ScheduleError('scheduleTaskAccessDenied',403)
    return issue
  }
  async command(actor: Actor, raw: unknown) {
    const parsed = commandSchema.safeParse(raw)
    if (!parsed.success) throw new ScheduleError('invalidScheduleCommand',400)
    const cmd = parsed.data
    if (cmd.action === 'duplicate') return this.duplicate(actor, cmd)
    return this.workspace(actor.ownerId,actor.workspaceId,access=>this.transaction(async tx=>{
      await this.conversation(tx,actor)
      await this.safeMessage(tx,actor.ownerId,cmd)
      if (cmd.action === 'list') {
        const limit = cmd.limit ?? SCHEDULE_PAGE_MAX
        const [at, id] = cmd.cursor?.split('/') ?? []
        // 我的自动化 (owner) and 定时 (trigger) narrow the same visible set; the counts below follow them too.
        const visible = `workspace_id IS NOT DISTINCT FROM $1::uuid
            AND ((visibility = 'workspace' AND $1::uuid IS NOT NULL)
              OR (visibility = 'owner' AND owner_id = $2 AND bot_id IS NOT DISTINCT FROM $3::uuid))
            AND ($4::boolean IS FALSE OR owner_id = $2)
            AND ($5::boolean IS FALSE OR definition->'timing'->>'kind' <> 'manual')
            AND (status_before_delete IS NOT NULL)=$6::boolean`
        const scope = [actor.workspaceId, actor.ownerId, actor.botId, cmd.owner === 'me', cmd.trigger === 'schedule', cmd.deleted ?? false]
        const { rows } = await tx.query<Schedule & { page_cursor: string }>(`
          SELECT ${SCHEDULE_COLUMNS}, EXISTS(SELECT 1 FROM schedule_pins p WHERE p.schedule_id=user_schedules.id AND p.user_id=$2) AS pinned, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '/' || id AS page_cursor
          FROM user_schedules
          WHERE ${visible}
            AND ($7::uuid IS NULL OR id = $7::uuid)
            AND ($8::timestamptz IS NULL OR (created_at, id) < ($8::timestamptz, $9::uuid))
          ORDER BY created_at DESC, id DESC
          LIMIT $10`, [...scope, cmd.scheduleId ?? null, at ?? null, id ?? null, limit + 1])
        const page = rows.slice(0, limit)
        // 运行中 N / 已暂停 N: the whole filtered list's sizes, read with its first page (the rows arrive 100 at a time).
        const counts = cmd.cursor || cmd.scheduleId ? undefined : (await tx.query<{ active: number; paused: number }>(`
          SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'paused')::int AS paused
          FROM user_schedules WHERE ${visible}`, scope)).rows[0]
        return {
          ...(counts ? { counts } : {}),
          // 接手 is offered to an owner or admin on another person's workspace automation.
          schedules: page.map(({ page_cursor: _cursor, ...schedule }) => ({ ...schedule, can_take_over: schedule.visibility === 'workspace' && schedule.owner_id !== actor.ownerId && access.role !== 'member' })),
          nextCursor: rows.length > limit ? page[limit - 1]!.page_cursor : null,
        }
      }
      if (cmd.action==='create') {
        if (!actor.workspaceId) throw new ScheduleError('scheduleWorkspaceRequired',400)
        await this.source(tx,actor,actor.workspaceId)
        const def = definitionSchema.parse(cmd.definition); def.timezone = timezone(def.timezone)
        // A page request has its own identity space: a chat's tool call IDs never collide with it.
        const origin = actor.direct ? 'page' : actor.botId ? `bot:${actor.botId}` : 'coordinator'
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['schedule',actor.ownerId,origin,cmd.requestId])])
        const old = (await tx.query<Schedule>(`SELECT ${SCHEDULE_COLUMNS} FROM user_schedules WHERE owner_id=$1 AND request_origin=$2 AND request_id=$3`,[actor.ownerId,origin,cmd.requestId])).rows[0]
        if (old) { if (!isDeepStrictEqual(old.request_definition,def) || old.workspace_id!==actor.workspaceId) throw new ScheduleError('scheduleRequestConflict'); return { schedule:old,replayed:true } }
        await this.permission(tx,actor.ownerId,actor.botId,actor.workspaceId,def)
        const next=nextTime(def,this.clock(),true)
        const {rows}=await tx.query<Schedule>(`INSERT INTO user_schedules(id,owner_id,workspace_id,bot_id,visibility,source_event_id,request_id,definition,request_definition,status,next_at,request_origin) VALUES($1,$2,$3,$4,'workspace',$5,$6,$7,$7,'active',$8,$9) RETURNING ${SCHEDULE_COLUMNS}`,[randomUUID(),actor.ownerId,actor.workspaceId,actor.botId,actor.direct?null:actor.sourceEventId,cmd.requestId,def,next,origin])
        await this.listChanged(tx,actor.workspaceId)
        return {schedule:rows[0],replayed:false}
      }
      const row=(await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1 AND workspace_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE',[cmd.scheduleId,actor.workspaceId])).rows[0]
      if(!row) throw new ScheduleError('scheduleNotFound',404)
      if(row.visibility==='owner'&&(row.owner_id!==actor.ownerId||row.bot_id!==actor.botId)) throw new ScheduleError('scheduleNotFound',404)
      if(row.visibility==='workspace'&&!actor.workspaceId) throw new ScheduleError('scheduleNotFound',404)
      // The run-as person may start and resume what they agreed to run, not change it.
      const runsAsActor=Boolean(row.run_as_user_id)&&row.run_as_user_id===actor.ownerId&&cmd.action!=='update'
      if((cmd.action==='update'||cmd.action==='restore'||cmd.action==='resume'||cmd.action==='run_now'||cmd.action==='flush_batch'||cmd.action==='cancel_batch')&&row.visibility==='workspace'&&row.owner_id!==actor.ownerId&&!runsAsActor&&access.role==='member') throw new ScheduleError('scheduleAdminRequired',403)
      if(cmd.action==='history'){
        // Seeing that a workspace schedule ran is collaboration; reading what it returned is not. Only the
        // creator, and an owner/admin, get result, error and the operation identity; any other active member
        // sees the run's status and timestamps with those fields blank. A member of a workspace that has no
        // roles runs as 'member'. Visibility is unchanged: an owner-only row is already 404 above.
        const privileged=row.owner_id===actor.ownerId||access.role!=='member'
        if (cmd.batches) {
          if (!privileged) throw new ScheduleError('scheduleAdminRequired', 403)
          const { status, limit = SCHEDULE_PAGE_MAX, cursor } = cmd.batches
          const [at, id] = cursor?.split('/') ?? []
          const { rows } = await tx.query<WebhookBatch & { page_cursor: string }>(`WITH batches AS (
              SELECT ${WEBHOOK_BATCH_COLUMNS}
              FROM schedule_occurrences
              WHERE schedule_id=$1 AND ${WEBHOOK_BATCH}
            )
            SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '/' || id AS page_cursor
            FROM batches WHERE ($3::text IS NULL OR status=$3)
              AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
            ORDER BY created_at DESC, id DESC LIMIT $6`,
          [row.id, row.version, status ?? null, at ?? null, id ?? null, limit+1])
          const page = rows.slice(0, limit)
          return {
            batches: page.map(({ page_cursor: _cursor, ...batch }) => publicBatch(batch)),
            nextCursor: rows.length > limit ? page[limit-1]!.page_cursor : null,
          }
        }
        // A run remains part of its Workspace's history when the Task it
        // produced or read changes audience. Its stored Task snapshot follows
        // the current content ACL, including for the schedule creator/admin.
        const taskVisible = issueVisibilityPredicate(actor.ownerId, { allowedIds: [], workspaceIds: row.workspace_id ? [row.workspace_id] : [] })
        const result = privileged ? sql`CASE
          WHEN o.definition#>>'{task,kind}' NOT IN ('dispatch_task','issue_snapshot') THEN o.result
          WHEN EXISTS (SELECT 1 FROM ${issues} WHERE ${issues.id}=CASE
            WHEN pg_input_is_valid(o.result->>'id','uuid') THEN (o.result->>'id')::uuid END
            AND ${taskVisible}) THEN o.result
          END` : sql`NULL`
        const seen = await drizzle(tx).execute(sql`SELECT id,schedule_id,operation_id,event_id,version,due_at,status,attempts,
          ${result} AS result,error,trigger,started_at,finished_at,reported_at,
          (${sql.raw(cancellableRun)} AND version=${row.version}) AS can_cancel
          FROM schedule_occurrences o WHERE schedule_id=${row.id} ORDER BY due_at DESC LIMIT 100`)
        return {occurrences:privileged?seen.rows:seen.rows.map(o=>({...o,operation_id:null,event_id:null,result:null,error:null,trigger:null,can_cancel:false}))}
      }
      if(cmd.action==='cancel_run'){
        if(row.owner_id!==actor.ownerId && access.role==='member') throw new ScheduleError('scheduleAdminRequired',403)
        await this.source(tx,actor,row.workspace_id)
        if(row.version!==cmd.version) throw new ScheduleError('scheduleVersionConflict')
        const run=(await tx.query<Occurrence & {can_cancel:boolean; finished_at:Date|null}>(`SELECT *,${cancellableRun} AS can_cancel
          FROM schedule_occurrences WHERE id=$1 AND schedule_id=$2 FOR UPDATE`,[cmd.runId,row.id])).rows[0]
        if(!run) throw new ScheduleError('scheduleRunNotFound',404)
        if(run.version!==row.version) throw new ScheduleError('scheduleVersionConflict')
        let completedAt = run.finished_at
        if (run.status !== 'cancelled' || run.error !== 'scheduleRunCancelled') {
          if(!run.can_cancel) throw new ScheduleError('scheduleRunNotQueued')
          const {rows: [updated]} = await tx.query<{finished_at: Date}>(`UPDATE schedule_occurrences
            SET status='cancelled',error='scheduleRunCancelled',finished_at=$2 WHERE id=$1 RETURNING finished_at`, [run.id,this.clock()])
          completedAt = updated!.finished_at
          await this.lockChat(tx,row)
          await this.report(tx,row,run,'cancelled',null,'scheduleRunCancelled')
        }
        return {
          runId: run.id, id: run.id, automationId: run.schedule_id, status: 'cancelled',
          jamId: null, failure: null, createdAt: run.created_at, startedAt: run.started_at, completedAt,
        } satisfies CancelledAutomationRun
      }
      if(row.status_before_delete && (cmd.action==='pin'||cmd.action==='organize')) throw new ScheduleError('scheduleCancelled')
      if(cmd.action==='pin'){
        const result = cmd.pinned
          ? await tx.query('INSERT INTO schedule_pins(user_id,schedule_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.ownerId,row.id])
          : await tx.query('DELETE FROM schedule_pins WHERE user_id=$1 AND schedule_id=$2',[actor.ownerId,row.id])
        if (result.rowCount) await this.listChanged(tx,row.workspace_id)
        return {pinned:cmd.pinned}
      }
      if(cmd.action==='organize'){
        if(row.visibility==='workspace'&&row.owner_id!==actor.ownerId&&access.role==='member') throw new ScheduleError('scheduleAdminRequired',403)
        const tags=[...new Set(cmd.tags.map(tag=>tag.normalize('NFC')))]
        const folder = cmd.folder?.normalize('NFC') ?? null
        const updated = (await tx.query<Schedule>(`UPDATE user_schedules SET folder=$2,tags=$3,updated_at=$4
          WHERE id=$1 AND (folder IS DISTINCT FROM $2 OR tags IS DISTINCT FROM $3) RETURNING ${SCHEDULE_COLUMNS}`,
          [row.id,folder,tags,this.clock()])).rows[0]
        if (updated) {
          await this.listChanged(tx,row.workspace_id)
          return {schedule:updated}
        }
        return {schedule:(await tx.query<Schedule>(`SELECT ${SCHEDULE_COLUMNS} FROM user_schedules WHERE id=$1`,[row.id])).rows[0]}
      }
      if(cmd.action==='usage'){
        // Days in the automation's own time zone. Cost is what the tasks it made spent through hosted models, billed
        // to the day the run started; like a run's result it is shown to the creator and owners/admins only.
        const days=cmd.days??14, zone=row.definition.timezone
        const runs=await tx.query<{day:string;runs:number;skipped:number;tasks:number}>(`SELECT to_char((created_at AT TIME ZONE $2)::date,'YYYY-MM-DD') AS day,
          count(*) FILTER (WHERE ${COUNTED})::int runs,count(*) FILTER (WHERE status='skipped')::int skipped,count(*) FILTER (WHERE result ? 'eventId')::int tasks
          FROM schedule_occurrences WHERE schedule_id=$1 AND created_at>=(date_trunc('day',now() AT TIME ZONE $2)-($3::int-1)*interval '1 day') AT TIME ZONE $2 GROUP BY 1 ORDER BY 1 DESC`,[row.id,zone,days])
        const privileged=row.owner_id===actor.ownerId||access.role!=='member'
        // Each task the automation made counts once, whether a run made it or added to it ('single'), on the day it spent.
        const cost=privileged?(await tx.query<{day:string;cost:string}>(`SELECT to_char((u."createdAt" AT TIME ZONE $2)::date,'YYYY-MM-DD') AS day,COALESCE(sum(u."costMicroUsd"),0)::text cost
          FROM (SELECT DISTINCT (result->>'id')::uuid task FROM schedule_occurrences WHERE schedule_id=$1 AND definition#>>'{task,kind}'='dispatch_task' AND result ? 'id') t
          JOIN agent_runs r ON r."issueId"=t.task JOIN hosted_usage u ON u."usageRunId"=r.id
          WHERE COALESCE(u."billingSource",'credits')='credits'
          AND u."createdAt">=(date_trunc('day',now() AT TIME ZONE $2)-($3::int-1)*interval '1 day') AT TIME ZONE $2 GROUP BY 1`,[row.id,zone,days])).rows:[]
        const spent=new Map(cost.map(item=>[item.day,Number(item.cost)]))
        const byDay=new Map(runs.rows.map(item=>[item.day,item]))
        for(const day of spent.keys())if(!byDay.has(day))byDay.set(day,{day,runs:0,skipped:0,tasks:0})
        return {timezone:zone,maxRunsPerDay:row.definition.maxRunsPerDay??null,days:[...byDay.values()].sort((a,b)=>b.day.localeCompare(a.day)).map(item=>({...item,costMicroUsd:privileged?spent.get(item.day)??0:null}))}
      }
      await this.source(tx,actor,row.workspace_id)
      if(row.version!==cmd.version) throw new ScheduleError('scheduleVersionConflict')
      if(cmd.action==='restore'){
        if(!row.status_before_delete) throw new ScheduleError('scheduleNotDeleted')
        this.consented(actor,access,row)
        let status = row.status_before_delete
        let next: Date | null = null
        if(status==='active'){
          if(row.owner_id!==actor.ownerId){
            if(!access.requireActiveMember) throw new ScheduleError('scheduleWorkspaceAccessDenied',403)
            await access.requireActiveMember(row.owner_id)
          }
          await this.conversation(tx,{ownerId:row.owner_id,workspaceId:row.workspace_id,botId:row.bot_id})
          await this.permission(tx,await this.runner(access,row,row.definition),row.bot_id,row.workspace_id,row.definition)
          next=nextTime(row.definition,this.clock())
          if(!next && runsOnSchedule(row.definition)) status='completed'
        }
        const updated=await tx.query<Schedule>(`UPDATE user_schedules SET status=$2,status_before_delete=NULL,next_at=$3,
          version=version+1,updated_at=$4 WHERE id=$1 RETURNING ${SCHEDULE_COLUMNS}`,[row.id,status,next,this.clock()])
        await this.listChanged(tx,row.workspace_id)
        return {schedule:updated.rows[0]}
      }
      if(row.status==='cancelled') throw new ScheduleError('scheduleCancelled')
      if(cmd.action==='flush_batch') this.consented(actor,access,row)
      if(cmd.action==='flush_batch'||cmd.action==='cancel_batch') return this.closeWebhookBatch(tx, row, cmd.batchId, cmd.action, access)
      if(cmd.action==='run_now'){this.consented(actor,access,row);return this.runNow(tx,row,cmd.requestId,access)}
      if(cmd.action==='run_as') return this.runAs(tx,actor,access,row,cmd.userId)
      if(cmd.action==='take_over') return this.takeOver(tx,actor,access,row)
      if(cmd.action==='webhook_key'){
        // The URL is a secret: it is made on the page and shown to the person, never handed to a chat model.
        if(!actor.direct) throw new ScheduleError('scheduleWebhookPageOnly',403)
        if(row.visibility==='workspace'&&row.owner_id!==actor.ownerId&&access.role==='member') throw new ScheduleError('scheduleAdminRequired',403)
        // The URL starts runs as the run-as person: making one is theirs (or an owner/admin's) to do.
        this.consented(actor,access,row)
        if(!row.definition.webhook||row.status==='completed') throw new ScheduleError('scheduleWebhookOff',409)
        const key=newWebhookKey()
        const updated=(await tx.query<Schedule>(`UPDATE user_schedules SET webhook_key_hash=$2,updated_at=$3 WHERE id=$1 RETURNING ${SCHEDULE_COLUMNS}`,[row.id,webhookKeyHash(key),this.clock()])).rows[0]
        await this.listChanged(tx,row.workspace_id)
        return {schedule:updated,key}
      }
      let def=row.definition, status=row.status, next=row.next_at, runAs=row.run_as_user_id??null
      if(cmd.action==='update'){
        def=cmd.definition;def.timezone=timezone(def.timezone)
        // A change by anyone but the run-as person returns the automation to its creator: that person agreed to run
        // what they saw, not what someone else writes after.
        if(runAs&&runAs!==actor.ownerId)runAs=null
        const runner=await this.runner(access,{...row,run_as_user_id:runAs},def)
        this.postAsConsented(actor,row,def,runner)
        await this.permission(tx,runner,row.bot_id,row.workspace_id,def);next=nextTime(def,this.clock(),true);if(status==='completed')status='active'}
      else if(cmd.action==='pause'){status='paused';next=null}
      else if(cmd.action==='cancel'||cmd.action==='delete'){status='cancelled';next=null}
      else {if(status!=='paused')throw new ScheduleError('scheduleNotPaused');this.consented(actor,access,row);await this.permission(tx,await this.runner(access,row,def),row.bot_id,row.workspace_id,def);next=nextTime(def,this.clock());status=next||!runsOnSchedule(def)?'active':'completed'}
      const stale=await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status='cancelled',error='scheduleChanged',lease_token=NULL,lease_until=NULL,finished_at=$2 WHERE schedule_id=$1 AND status IN ('pending','running') RETURNING *`,[row.id,this.clock()])
      if (stale.rows.length) {
        await this.lockChat(tx,row)
        for (const item of stale.rows) {
          await this.retireEvent(tx,item.event_id)
          await this.report(tx,row,item,'cancelled',null,'scheduleChanged')
        }
      }
      const updated=(await tx.query<Schedule>(`UPDATE user_schedules SET definition=$2,status=$3,next_at=$4,version=version+1,updated_at=$5,status_before_delete=CASE WHEN $6 THEN status END,disabled_reason=CASE WHEN $3='paused' OR $6 THEN disabled_reason END,run_as_user_id=$7,
        webhook_key_hash=CASE WHEN run_as_user_id IS DISTINCT FROM $7 THEN NULL ELSE webhook_key_hash END WHERE id=$1 RETURNING ${SCHEDULE_COLUMNS}`,[row.id,def,status,next,this.clock(),cmd.action==='delete',runAs])).rows[0]
      await this.listChanged(tx,row.workspace_id)
      return {schedule:updated}
    }))
  }
  /** Close only a collecting window under the same schedule lock used by ingress. The normal worker owns dispatch. */
  private async closeWebhookBatch(tx: PoolClient, row: Schedule, batchId: string, action: 'flush_batch' | 'cancel_batch', access: WorkspaceAccess) {
    if (row.status !== 'active') throw new ScheduleError('scheduleNotActive')
    const batch = (await tx.query<{ closedBy: string | null }>(`SELECT trigger#>>'{webhook,closedBy}' AS "closedBy"
      FROM schedule_occurrences WHERE schedule_id=$1 AND version=$2 AND id=$3 AND ${WEBHOOK_BATCH} FOR UPDATE`,
    [row.id, row.version, batchId])).rows[0]
    if (!batch) throw new ScheduleError('scheduleBatchNotFound', 404)
    const status: 'queued' | 'cancelled' = action === 'flush_batch' ? 'queued' : 'cancelled'
    const replayed = batch.closedBy === action
    if (!replayed) {
      const open = await tx.query(`SELECT 1 WHERE $3::uuid=(${COLLECTING_WINDOW})`, [row.id, row.version, batchId])
      if (!open.rowCount) throw new ScheduleError('scheduleBatchClosed')
      if (action === 'flush_batch') {
        await this.permission(tx, await this.runner(access, row, row.definition), row.bot_id, row.workspace_id, row.definition)
        await tx.query(`UPDATE schedule_occurrences SET next_retry_at=statement_timestamp(),
          trigger=jsonb_set(trigger,'{webhook}',(trigger->'webhook') || jsonb_build_object('closedBy','flush_batch','closedAt',statement_timestamp())) WHERE id=$1`, [batchId])
      } else {
        // Retain the aggregate payload size, timestamps and deduplication hashes while erasing every body.
        await tx.query(`UPDATE schedule_occurrences SET status='cancelled',finished_at=statement_timestamp(),reported_at=statement_timestamp(),
          trigger=jsonb_build_object('webhook',jsonb_build_object('closedBy','cancel_batch','closedAt',statement_timestamp(),'byteCount',${WEBHOOK_BODY_BYTES},'requests',(
            SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('at',r->'at','keyHash',
              encode(sha256(convert_to(r->>'key','UTF8')),'hex'))) ORDER BY n)
            FROM jsonb_array_elements(trigger->'webhook'->'requests') WITH ORDINALITY AS requests(r,n)
          ))) WHERE id=$1`, [batchId])
      }
      await this.listChanged(tx,row.workspace_id)
    }
    const { rows: [record] } = await tx.query<WebhookBatch>(`SELECT ${WEBHOOK_BATCH_COLUMNS}
      FROM schedule_occurrences WHERE schedule_id=$1 AND version=$2 AND id=$3`, [row.id, row.version, batchId])
    return { ...publicBatch(record!), batchId, status, replayed } satisfies WebhookBatchClosure
  }
  /**
   * Duplicate to: a copy of an automation the person can see, created as theirs in a workspace they are an active
   * member of (this one or another). Everything it uses is checked again there; what the target cannot use is cleared
   * (the Bot falls back to the Coordinator, triggers and channels are dropped) and named in `cleared`, and such a copy
   * starts paused. The webhook key, pins and run history stay with the original. The request ID makes a retry return
   * the first copy.
   */
  private async duplicate(actor: Actor, cmd: Extract<Command, { action: 'duplicate' }>) {
    if (!actor.direct) throw new ScheduleError('scheduleUserSourceRequired',403)
    const source = await this.workspace(actor.ownerId,actor.workspaceId,()=>this.transaction(async tx=>{
      await this.conversation(tx,actor)
      const row=(await tx.query<Schedule & { folder: string | null; tags: string[] }>('SELECT * FROM user_schedules WHERE id=$1 AND workspace_id IS NOT DISTINCT FROM $2::uuid AND status_before_delete IS NULL',[cmd.scheduleId,actor.workspaceId])).rows[0]
      if(!row||(row.visibility==='owner'&&(row.owner_id!==actor.ownerId||row.bot_id!==actor.botId))||(row.visibility==='workspace'&&!actor.workspaceId))throw new ScheduleError('scheduleNotFound',404)
      return row
    }))
    return this.workspace(actor.ownerId,cmd.targetWorkspaceId,()=>this.transaction(async tx=>{
      // The copy reports to the person's Coordinator chat in the target workspace, like one made on its page.
      const target: Actor = { ownerId: actor.ownerId, workspaceId: cmd.targetWorkspaceId, botId: await this.automation.chat?.(actor.ownerId,cmd.targetWorkspaceId) ?? null, direct: true }
      await this.conversation(tx,target)
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['schedule',actor.ownerId,'page',cmd.requestId])])
      const old=(await tx.query<Schedule>(`SELECT ${SCHEDULE_COLUMNS} FROM user_schedules WHERE owner_id=$1 AND request_origin='page' AND request_id=$2`,[actor.ownerId,cmd.requestId])).rows[0]
      if(old){if(old.workspace_id!==target.workspaceId)throw new ScheduleError('scheduleRequestConflict');return {schedule:old,cleared:[] as string[],replayed:true}}
      const {definition,cleared}=await this.fitDefinition(tx,target,source.definition)
      const paused=cleared.length>0
      const next=paused?null:nextTime(definition,this.clock(),true)
      const {rows}=await tx.query<Schedule>(`INSERT INTO user_schedules(id,owner_id,workspace_id,bot_id,visibility,source_event_id,request_id,definition,request_definition,status,next_at,request_origin,folder,tags)
        VALUES($1,$2,$3,$10,'workspace',NULL,$4,$5,$5,$6,$7,'page',$8,$9) RETURNING ${SCHEDULE_COLUMNS}`,
        [randomUUID(),actor.ownerId,target.workspaceId,cmd.requestId,definition,paused||(!next&&runsOnSchedule(definition))?'paused':'active',next,source.folder,source.tags,target.botId])
      await this.listChanged(tx,target.workspaceId)
      return {schedule:rows[0],cleared,replayed:false}
    }))
  }
  /** The definition with what `actor` cannot use in its workspace cleared, and the names of the cleared fields. */
  private async fitDefinition(tx: PoolClient, actor: Actor, original: Definition): Promise<{ definition: Definition; cleared: string[] }> {
    let definition: Definition = structuredClone(original)
    const cleared: string[] = []
    const drop = (source: EventTrigger['source']) => {
      const events = (definition.events ?? []).filter(trigger => trigger.source !== source)
      const { events: _events, ...rest } = definition
      definition = events.length ? { ...rest, events } : rest
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      try { await this.permission(tx,actor.ownerId,actor.botId,actor.workspaceId,definition); return { definition, cleared } }
      catch (error) {
        if (!(error instanceof ScheduleError) || definition.task.kind !== 'dispatch_task') throw error
        const task: DispatchTask = definition.task
        const field = ({
          scheduleBotUnavailable: () => task.botId ? (definition = { ...definition, task: { ...task, botId: null } }, 'bot') : null,
          scheduleDeviceUnavailable: () => task.destination ? (definition = { ...definition, task: { ...task, destination: undefined } }, 'machine') : null,
          scheduleProfileUnavailable: () => task.profileId ? (definition = { ...definition, task: { ...task, profileId: undefined } }, 'profile') : null,
          scheduleEnvironmentUnavailable: () => { const { environmentId: _id, ...rest } = definition; definition = rest; return 'environment' },
          scheduleThreadUnavailable: () => { const { singleThreadId: _id, ...rest } = definition; definition = { ...rest, eachRun: 'new_task' }; return 'thread' },
          scheduleLinearUnavailable: () => (drop('linear'), 'linear'),
          scheduleSlackUnavailable: () => { drop('slack'); const { notify: _notify, ...rest } = definition; definition = rest; return 'slack' },
          // A Bot's repository, or a repository a GitHub trigger names.
          scheduleRepositoryUnavailable: () => definition.events?.some(trigger => trigger.source === 'github') ? (drop('github'), 'github') : task.botId ? (definition = { ...definition, task: { ...task, botId: null } }, 'bot') : null,
        } as Record<string, () => string | null>)[error.code]?.()
        if (!field) throw error
        // Undefined keys are not part of a stored definition.
        definition = definitionSchema.parse(JSON.parse(JSON.stringify(definition)))
        if (!cleared.includes(field)) cleared.push(field)
      }
    }
    throw new ScheduleError('scheduleDispatchUnavailable',503)
  }
  /**
   * Runs as, by consent: a person can make an automation run as themselves, and only themselves; it then acts, is
   * billed and posts as them. The creator, an owner/admin or that person can return it to the creator. Only a
   * dispatched task runs as someone, with that person's authority, checked now and at every run. Posting under a
   * person's name stays on only when the person it now runs as turned it on. Runs that had not started are cancelled.
   */
  private async runAs(tx:PoolClient,actor:Actor,access:WorkspaceAccess,row:Schedule,userId:string|null){
    if(row.visibility!=='workspace'||!row.workspace_id) throw new ScheduleError('scheduleNotFound',404)
    const target=userId===row.owner_id?null:userId
    if(target&&target!==actor.ownerId) throw new ScheduleError('scheduleRunAsConsentRequired',403)
    if(!target&&row.owner_id!==actor.ownerId&&row.run_as_user_id!==actor.ownerId&&access.role==='member') throw new ScheduleError('scheduleAdminRequired',403)
    if(target&&row.definition.task.kind!=='dispatch_task') throw new ScheduleError('invalidScheduleCommand',400)
    if((row.run_as_user_id??null)===target) return {schedule:(await tx.query<Schedule>(`SELECT ${SCHEDULE_COLUMNS} FROM user_schedules WHERE id=$1`,[row.id])).rows[0]}
    // The person it now runs as did not turn on posting under their name unless they are the one changing it.
    const slack=row.definition.notify?.slack
    const def:Definition=slack?.postAsRunner&&actor.ownerId!==(target??row.owner_id)
      ?{...row.definition,notify:{slack:(({postAsRunner:_off,...rest})=>rest)(slack)}}:row.definition
    const next={...row,run_as_user_id:target}
    if(row.status==='active') await this.permission(tx,await this.runner(access,next,def),row.bot_id,row.workspace_id,def)
    else if(target) await this.runner(access,next,def)
    const stale=await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status='cancelled',error='scheduleChanged',lease_token=NULL,lease_until=NULL,finished_at=$2 WHERE schedule_id=$1 AND status IN ('pending','running') RETURNING *`,[row.id,this.clock()])
    if (stale.rows.length) {
      await this.lockChat(tx,row)
      for (const item of stale.rows) {
        await this.retireEvent(tx,item.event_id)
        await this.report(tx,row,item,'cancelled',null,'scheduleChanged')
      }
    }
    const updated=(await tx.query<Schedule>(`UPDATE user_schedules SET run_as_user_id=$2,definition=$4,webhook_key_hash=NULL,version=version+1,updated_at=$3 WHERE id=$1 RETURNING ${SCHEDULE_COLUMNS}`,[row.id,target,this.clock(),def])).rows[0]
    await this.listChanged(tx,row.workspace_id)
    return {schedule:updated}
  }
  /**
   * 接手: the automation becomes the actor's. It runs as them from now on, reports to their chat, and its authority is
   * theirs, checked now. When something it uses is not theirs to use (another person's Bot, a repository outside the
   * workspace), it is taken over paused with that reason, so they can change it and turn it back on. Runs that had not
   * started are cancelled; a 追加到同一个任务 automation starts a new task of theirs on its next run.
   */
  private async takeOver(tx:PoolClient,actor:Actor,access:WorkspaceAccess,row:Schedule){
    if(row.visibility!=='workspace'||!row.workspace_id) throw new ScheduleError('scheduleNotFound',404)
    if(row.owner_id===actor.ownerId) return {schedule:row}
    if(access.role==='member') throw new ScheduleError('scheduleAdminRequired',403)
    let status=row.status, next=row.next_at, reason:string|null=null
    if(status==='active'||(status==='paused'&&row.disabled_reason)){
      try{await this.permission(tx,actor.ownerId,actor.botId,row.workspace_id,row.definition);if(status==='paused'){next=nextTime(row.definition,this.clock());status=next||!runsOnSchedule(row.definition)?'active':'completed'}}
      catch(error){if(!(error instanceof ScheduleError)||!AUTHORITY_LOST.has(error.code))throw error;status='paused';next=null;reason=error.code}
    }
    const stale=await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status='cancelled',error='scheduleChanged',lease_token=NULL,lease_until=NULL,finished_at=$2 WHERE schedule_id=$1 AND status IN ('pending','running') RETURNING *`,[row.id,this.clock()])
    if (stale.rows.length) {
      await this.lockChat(tx,row)
      for (const item of stale.rows) {
        await this.retireEvent(tx,item.event_id)
        await this.report(tx,row,item,'cancelled',null,'scheduleChanged')
      }
    }
    const updated=(await tx.query<Schedule>(`UPDATE user_schedules SET owner_id=$2,webhook_key_hash=CASE WHEN run_as_user_id IS NULL THEN webhook_key_hash END,run_as_user_id=NULL,bot_id=$3,source_event_id=NULL,status=$4,next_at=$5,disabled_reason=$6,version=version+1,updated_at=$7 WHERE id=$1 RETURNING ${SCHEDULE_COLUMNS}`,[row.id,actor.ownerId,actor.botId,status,next,reason,this.clock()])).rows[0]
    await this.listChanged(tx,row.workspace_id)
    return {schedule:updated}
  }
  /**
   * 立即运行: one occurrence due now, run by the same claim and execute path as a timed one (so maxConcurrent, the
   * creator's authority and the report apply unchanged). Its operation ID derives from the request, so a repeated
   * request returns the first occurrence instead of adding another.
   */
  private async runNow(tx: PoolClient, row: Schedule, requestId: string, access: WorkspaceAccess) {
    const operation = scheduleOperationId(row.id, requestId)
    const replay = async () => (await tx.query<Occurrence>('SELECT * FROM schedule_occurrences WHERE operation_id=$1 AND schedule_id=$2', [operation, row.id])).rows[0]
    const prior = await replay()
    if (prior) return { schedule: scheduleView(row), occurrence: prior, replayed: true }
    if (row.status !== 'active') throw new ScheduleError('scheduleNotActive')
    await this.permission(tx, await this.runner(access, row, row.definition), row.bot_id, row.workspace_id, row.definition)
    const { rows: [busy] } = await tx.query<{ n: number }>(`SELECT count(*)::int n FROM schedule_occurrences WHERE schedule_id=$1 AND status IN ('pending','running')`, [row.id])
    if (busy.n >= (row.definition.maxConcurrent ?? 1)) throw new ScheduleError('scheduleConcurrencyLimit')
    if (await this.dailyFull(tx, row)) throw new ScheduleError('scheduleDailyRunLimit')
    const now = this.clock()
    const { rows: [occurrence] } = await tx.query<Occurrence>(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,operation_id,next_retry_at,execution_decision)
      VALUES($1,$2,$3,$4,$5,'pending',$6,$4,'execute') ON CONFLICT DO NOTHING RETURNING *`, [randomUUID(), row.id, row.version, now, row.definition, operation])
    if (!occurrence) throw new ScheduleError('scheduleRunConflict')
    await this.listChanged(tx, row.workspace_id)
    return { schedule: scheduleView(row), occurrence, replayed: false }
  }
  async materialize(limit=50){return this.transaction(async tx=>{
    const now=this.clock()
    const {rows}=await tx.query<Schedule>(`SELECT * FROM user_schedules WHERE status='active' AND next_at<=$1 ORDER BY next_at LIMIT $2 FOR UPDATE SKIP LOCKED`,[now,limit])
    for(const row of rows){const late=now.getTime()-row.next_at!.getTime()>row.definition.maxLatenessMinutes*60000;const skip=late&&row.definition.misfire==='skip';const next=nextTime(row.definition,now)
      await tx.query(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,operation_id,next_retry_at,execution_decision) VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8) ON CONFLICT(schedule_id,version,due_at) DO NOTHING`,[randomUUID(),row.id,row.version,row.next_at,row.definition,randomUUID(),now,skip?'skip':'execute'])
      await tx.query('UPDATE user_schedules SET next_at=$2,status=$3,updated_at=$4 WHERE id=$1',[row.id,next,next?'active':'completed',now])
      await this.listChanged(tx,row.workspace_id)
    } return rows.length
  })}
  async claim(){return this.transaction(async tx=>{
    const now=this.clock()
    const {rows}=await tx.query<Occurrence>(`WITH due AS(SELECT id FROM schedule_occurrences WHERE (status='pending' AND next_retry_at<=$1) OR(status='running' AND lease_until<=$1) ORDER BY next_retry_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE schedule_occurrences o SET status=CASE WHEN attempts >= 3 THEN 'failed' ELSE 'running' END,error=CASE WHEN attempts >= 3 THEN 'scheduleRecoveryExhausted' ELSE error END,finished_at=CASE WHEN attempts >= 3 THEN $1 ELSE finished_at END,lease_token=CASE WHEN attempts >= 3 THEN NULL ELSE $2::uuid END,lease_until=CASE WHEN attempts >= 3 THEN NULL ELSE $3::timestamptz END,attempts=LEAST(attempts+1,3),started_at=COALESCE(started_at,$1) FROM due WHERE o.id=due.id RETURNING o.*`,[now,randomUUID(),new Date(now.getTime()+SCHEDULE_LEASE_MS)])
    return rows[0]??null
  })}
  private async lockChat(tx:PoolClient,row:Schedule){await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`bot-chat:${row.owner_id}:${row.bot_id??'coordinator'}`])}
  private async retireEvent(tx:PoolClient,id:string|null){if(id)await tx.query(`UPDATE coordinator_events SET "deliveredAt"=COALESCE("deliveredAt",$2),tier='background' WHERE id=$1`,[id,this.clock()])}
  /** Called with the original chat locked through the occurrence's event and report writes. */
  private async report(tx:PoolClient,row:Schedule,o:Occurrence,status:string,result:unknown,error:string|null,streamId?:string){
    const message=scheduleChatMessage(o.definition.title,status,result)
    await this.safeMessage(tx,row.owner_id,message)
    const inserted = await tx.query(`INSERT INTO coordinator_messages(id,"userId","botId",position,message) SELECT $1,$2,$3,COALESCE(MAX(position),0)+1,$4 FROM coordinator_messages WHERE "userId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid ON CONFLICT(id) DO NOTHING`,[o.operation_id,row.owner_id,row.bot_id,{...message,...(streamId?{mikkaStreamId:streamId}:{})}])
    if (inserted.rowCount) await botChatChanged(tx, row.owner_id, row.bot_id)
    if (inserted.rowCount) await coordinatorSessionChanged(tx, row.owner_id, row.bot_id)
    // A result is already in the chat. Whether it also needs the person (a failure, a skipped or cancelled run, a result they would want flagged)
    // is triage's call on the Decisions API, not a fixed background tier: the event is left untriaged and undelivered.
    await tx.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1,$2,$3,'run_report',$4,$5) ON CONFLICT("dedupeKey") DO NOTHING`,[o.id,row.owner_id,row.bot_id,`schedule_result:${o.id}`,{source:'schedule_result',scheduleId:row.id,title:o.definition.title,occurrenceId:o.id,operationId:o.operation_id,status,error}])
    wakeCoordinatorAfterCommit(tx,row.owner_id)
    await tx.query('UPDATE schedule_occurrences SET reported_at=$2,report_attempts=report_attempts+1 WHERE id=$1',[o.id,this.clock()])
    await this.listChanged(tx,row.workspace_id)
  }
  private async concurrencyLimited(tx:PoolClient,o:Occurrence,max:number){
    const started=o.started_at??o.created_at
    const {rows}=await tx.query<{n:number}>(`SELECT count(*)::int n FROM schedule_occurrences r WHERE r.schedule_id=$1 AND r.status='running' AND r.id<>$2 AND (COALESCE(r.started_at,r.created_at)<$3 OR (COALESCE(r.started_at,r.created_at)=$3 AND r.id<$2))`,[o.schedule_id,o.id,started])
    return rows[0].n>=max
  }
  async execute(claim:Occurrence){
    const row=(await this.pool.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1',[claim.schedule_id])).rows[0]
    if(!row)return
    if(claim.status==='failed'){
      if (claim.event_id) await this.transaction(async tx=>{await this.lockChat(tx,row);await this.retireEvent(tx,claim.event_id)})
      await this.publishFailedReport(claim)
      return
    }
    try{const outcome=await this.workspace(row.owner_id,row.workspace_id,access=>this.transaction(async (tx):Promise<string|{dispatch:Occurrence,runner:string}|undefined>=>{
      const current=(await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1 FOR UPDATE',[row.id])).rows[0]
      const o=(await tx.query<Occurrence>(`SELECT * FROM schedule_occurrences WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>$3 FOR UPDATE`,[claim.id,claim.lease_token,this.clock()])).rows[0]
      if(!o)return
      if(current.version!==o.version||['paused','cancelled'].includes(current.status))return
      await this.lockChat(tx,row)
      await this.retireEvent(tx,o.event_id)
      await this.conversation(tx,{ownerId:row.owner_id,workspaceId:row.workspace_id,botId:row.bot_id})
      if(o.attempts>MAX_ATTEMPTS)throw new ScheduleError('scheduleRecoveryExhausted')
      const misfireSkipped=o.execution_decision==='skip'
      const concurrencyLimited=!misfireSkipped&&await this.concurrencyLimited(tx,o,current.definition.maxConcurrent??1)
      const dailyLimited=!misfireSkipped&&!concurrencyLimited&&await this.dailyFull(tx,current,o.id)
      const skipReason=misfireSkipped?'misfireSkipped':concurrencyLimited?'concurrencyLimit':dailyLimited?'dailyRunLimit':null
      const runner=skipReason?row.owner_id:await this.runner(access,current,o.definition)
      const issue=skipReason?null:await this.permission(tx,runner,row.bot_id,row.workspace_id,o.definition)
      const task=o.definition.task
      // The task is created and handed over after this commit, outside the schedule's locks; the lease fences it.
      if(!skipReason&&task.kind==='dispatch_task')return {dispatch:o,runner}
      if(!skipReason&&task.kind==='agent_read'){
        const eventId=randomUUID()
        await tx.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,tier) VALUES($1,$2,$3,'run_report',$4,$5,'attention')`,[eventId,row.owner_id,row.bot_id,`schedule_due:${o.id}:${o.attempts}`,{source:'schedule_due',scheduleId:row.id,title:o.definition.title,occurrenceId:o.id,text:task.prompt}])
        await botChatChanged(tx, row.owner_id, row.bot_id)
        await tx.query('UPDATE schedule_occurrences SET event_id=$2 WHERE id=$1',[o.id,eventId])
        return row.owner_id
      }
      const result=skipReason?null:task.kind==='reminder'?{text:task.text}:issue
      const status=skipReason?'skipped':'succeeded'
      await tx.query('UPDATE schedule_occurrences SET status=$2,result=$3,error=$4,finished_at=$5,lease_token=NULL,lease_until=NULL WHERE id=$1',[o.id,status,result,skipReason,this.clock()])
      await this.report(tx,row,o,status,result,skipReason)
    }))
    return typeof outcome==='object'?await this.finishDispatch(row,outcome.dispatch,outcome.runner):outcome
    }catch(error){await this.fail(claim,error)}
  }
  /** Creates and hands over the task as its creator, then records the run and posts its task line in the chat. */
  private async finishDispatch(row:Schedule,o:Occurrence,runner:string){
    const d=o.definition, task=d.task
    if(!this.automation.dispatch||!row.workspace_id||task.kind!=='dispatch_task')throw new ScheduleError('scheduleDispatchUnavailable',503)
    const source=!o.trigger?undefined:'event' in o.trigger?o.trigger.event.source:'webhook' as const
    const event=!o.trigger?undefined:'event' in o.trigger?(o.trigger.event.source==='linear'?describeLinearEvent(o.trigger.event):o.trigger.event.source==='slack'?describeSlackEvent(o.trigger.event):describeGitHubEvent(o.trigger.event)):describeWebhook(o.trigger.webhook.requests)
    if(o.trigger&&'event' in o.trigger&&event&&!await this.runWhenHolds(row,o,event))return this.skipQuietly(row,o,'runWhenNotMet')
    const run:DispatchRun={...(d.environmentId?{environmentId:d.environmentId}:{}),...(d.model?{model:d.model}:{}),...(d.machineSize?{machineSize:d.machineSize}:{}),...(d.runs?{runs:d.runs}:{})}
    const result=await this.automation.dispatch({ownerId:runner,workspaceId:row.workspace_id,scheduleId:row.id,occurrenceId:o.id,task,...(event&&source?{event,source}:{}),
      ...(d.eachRun==='same_task'?{single:true as const}:{}),...(d.eachRun==='existing_thread'&&d.singleThreadId?{thread:d.singleThreadId}:{}),...(Object.keys(run).length?{run}:{})})
    const recorded=await this.workspace(row.owner_id,row.workspace_id,()=>this.transaction(async tx=>{
      await tx.query('SELECT id FROM user_schedules WHERE id=$1 FOR UPDATE',[row.id])
      // A lost lease means another worker owns this occurrence; it repeats the same idempotent dispatch.
      const done=(await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status='succeeded',result=$3,error=NULL,finished_at=$4,lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING *`,[o.id,o.lease_token,result,this.clock()])).rows[0]
      if(!done)return false
      // 查看运行: only a task this run made (requestedBy, as the migration's backfill) remembers the automation; a run
      // that continued an existing task or thread (continued) leaves that task as it was.
      if(result.requestedBy&&!result.continued&&UUID.test(result.id))await tx.query('UPDATE issues SET source_schedule_id=$2 WHERE id=$1::uuid AND source_schedule_id IS NULL',[result.id,row.id])
      await this.lockChat(tx,row)
      await this.report(tx,row,done,'succeeded',result,null)
      return true
    }))
    if(recorded)await this.notice(o.id,'succeeded')
    // The request event waits in the runner's Bot chat: waking their chats delivers it.
    return recorded?runner:undefined
  }
  /**
   * 满足任一条件就运行: the run goes ahead when any trigger that took the event has no condition, or one of their
   * conditions holds. No answer from the Decision model is a retryable failure, never a silent pass or skip.
   */
  private async runWhenHolds(row:Schedule,o:Occurrence,event:string){
    const triggers=(o.trigger&&'triggers' in o.trigger?o.trigger.triggers:[]).map(index=>o.definition.events?.[index]).filter((trigger):trigger is EventTrigger=>Boolean(trigger))
    if(!triggers.length||triggers.some(trigger=>!trigger.runWhen))return true
    if(!this.automation.runWhen||!row.workspace_id)throw new ScheduleError('scheduleRunWhenUnavailable',503)
    for(const trigger of triggers){
      const holds=await this.automation.runWhen({ownerId:row.run_as_user_id??row.owner_id,workspaceId:row.workspace_id,condition:trigger.runWhen!,event})
      if(holds===null)throw new ScheduleError('scheduleRunWhenUnavailable',503)
      if(holds)return true
    }
    return false
  }
  /** An event that did not need a run: recorded in the history, not posted to the chat. */
  private async skipQuietly(row:Schedule,o:Occurrence,reason:string){
    await this.transaction(async tx=>{
      await tx.query(`UPDATE schedule_occurrences SET status='skipped',error=$3,finished_at=$4,reported_at=$4,lease_token=NULL,lease_until=NULL WHERE id=$1 AND status='running' AND lease_token=$2`,[o.id,o.lease_token,reason,this.clock()])
      await this.listChanged(tx,row.workspace_id)
    })
    return undefined
  }
  /**
   * A verified GitHub delivery: one run for each active automation that has a trigger taking any of its events, keyed
   * by the delivery so a redelivery adds nothing. The repository must still be usable in the automation's workspace.
   * Over the concurrency limit the event is recorded as skipped. Returns how many runs were queued.
   */
  async fireEvents(deliveryKey:string,events:readonly GitHubAutomationEvent[]){
    if(!events.length)return 0
    const repositories=[...new Set(events.map(event=>event.repository))]
    const names=[...new Set(events.map(event=>event.event))]
    const candidates=(await this.pool.query<Schedule>(`SELECT * FROM user_schedules s WHERE status='active' AND definition ? 'events' AND workspace_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.definition->'events') t WHERE t->>'event'=ANY($1::text[]) AND (t->'repositories') ?| $2::text[])`,[names,repositories])).rows
    let queued=0
    const usable=new Map<string,Promise<boolean>>()
    for(const candidate of candidates){
      const matched=events.flatMap(event=>(candidate.definition.events??[]).flatMap((trigger,index)=>triggerMatches(trigger,event)?[{event,index}]:[]))
      if(!matched.length)continue
      const event=matched[0]!.event
      const key=`${candidate.workspace_id}:${event.repository}`
      if(!usable.has(key))usable.set(key,this.automation.repository?this.automation.repository(candidate.workspace_id!,event.repository).catch(()=>false):Promise.resolve(false))
      if(!await usable.get(key))continue
      queued+=await this.queueEvent(candidate,deliveryKey,{event,triggers:[...new Set(matched.filter(item=>item.event===event).map(item=>item.index))]})
    }
    return queued
  }
  /**
   * A verified Linear delivery, the same way: one run per automation whose Linear trigger takes one of its events, while
   * the creator still has a Linear connection to the event's organization (that is what lets them see its teams).
   */
  async fireLinearEvents(deliveryKey:string,events:readonly LinearAutomationEvent[]){
    if(!events.length)return 0
    const names=[...new Set(events.map(event=>event.event))], teams=[...new Set(events.map(event=>event.teamId))]
    const candidates=(await this.pool.query<Schedule>(`SELECT s.* FROM user_schedules s JOIN linear_connections c ON c."userId"=COALESCE(s.run_as_user_id,s.owner_id) AND c."organizationId"=$3 AND c."revokedAt" IS NULL
      WHERE s.status='active' AND s.definition ? 'events' AND s.workspace_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.definition->'events') t WHERE t->>'source'='linear' AND t->>'event'=ANY($1::text[]) AND (t->'teams') ?| $2::text[])`,[names,teams,events[0]!.organizationId])).rows
    let queued=0
    for(const candidate of candidates){
      const matched=events.flatMap(event=>(candidate.definition.events??[]).flatMap((trigger,index)=>trigger.source==='linear'&&linearTriggerMatches(trigger,event)?[{event,index}]:[]))
      if(!matched.length)continue
      const event=matched[0]!.event
      queued+=await this.queueEvent(candidate,deliveryKey,{event,triggers:[...new Set(matched.filter(item=>item.event===event).map(item=>item.index))]})
    }
    return queued
  }
  /**
   * A signed Slack event, the same way: one run per automation whose Slack trigger takes it, in a workspace whose Slack
   * installation is this app's install in this team, while the creator is still a member of that installation.
   */
  async fireSlackEvents(deliveryKey:string,events:readonly SlackAutomationEvent[]){
    if(!events.length)return 0
    const first=events[0]!
    const names=[...new Set(events.map(event=>event.event))], channels=[...new Set(events.map(event=>event.channel))]
    const candidates=(await this.pool.query<Schedule>(`SELECT s.* FROM user_schedules s
      JOIN mikka_slack_installations i ON i.workspace_id=s.workspace_id AND i.app_id=$3 AND i.team_id=$4 AND NOT i.revoking
      JOIN mikka_slack_members m ON m.installation_id=i.id AND m.user_id=COALESCE(s.run_as_user_id,s.owner_id)
      WHERE s.status='active' AND s.definition ? 'events'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(s.definition->'events') t WHERE t->>'source'='slack' AND t->>'event'=ANY($1::text[]) AND (t->'channels') ?| $2::text[])`,[names,channels,first.appId,first.teamId])).rows
    let queued=0
    for(const candidate of candidates){
      const matched=events.flatMap(event=>(candidate.definition.events??[]).flatMap((trigger,index)=>trigger.source==='slack'&&slackTriggerMatches(trigger,event)?[{event,index}]:[]))
      if(!matched.length)continue
      const event=matched[0]!.event
      queued+=await this.queueEvent(candidate,deliveryKey,{event,triggers:[...new Set(matched.filter(item=>item.event===event).map(item=>item.index))]})
    }
    return queued
  }
  /** One event run for an automation, once per delivery; over maxConcurrent or the daily cap it is a skipped run. */
  private async queueEvent(candidate:Schedule,deliveryKey:string,trigger:OccurrenceTrigger){
    return this.transaction(async tx=>{
      const row=(await tx.query<Schedule>(`SELECT * FROM user_schedules WHERE id=$1 AND status='active' FOR UPDATE`,[candidate.id])).rows[0]
      if(!row||row.version!==candidate.version)return 0
      const operation=scheduleOperationId(row.id,`event:${deliveryKey}`)
      if((await tx.query('SELECT 1 FROM schedule_occurrences WHERE operation_id=$1',[operation])).rowCount)return 0
      const {rows:[busy]}=await tx.query<{n:number}>(`SELECT count(*)::int n FROM schedule_occurrences WHERE schedule_id=$1 AND status IN ('pending','running')`,[row.id])
      const reason=busy.n>=(row.definition.maxConcurrent??1)?'concurrencyLimit':await this.dailyFull(tx,row)?'dailyRunLimit':null
      const limited=reason!==null
      const inserted=await tx.query(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,operation_id,next_retry_at,execution_decision,trigger,error,finished_at,reported_at)
        VALUES($1,$2,$3,clock_timestamp(),$4,$5,$6,clock_timestamp(),'execute',$7,$8,CASE WHEN $5='skipped' THEN clock_timestamp() END,CASE WHEN $5='skipped' THEN clock_timestamp() END) ON CONFLICT DO NOTHING`,
        [randomUUID(),row.id,row.version,row.definition,limited?'skipped':'pending',operation,trigger,reason])
      if(inserted.rowCount)await this.listChanged(tx,row.workspace_id)
      return inserted.rowCount&&!limited?1:0
    })
  }
  /**
   * A request to an automation's webhook URL. With batchMinutes 0 it is a run now; otherwise it joins the run that is
   * still gathering requests, or starts one due batchMinutes from now. Over maxConcurrent or the daily cap the request
   * is recorded as a skipped run, with its body, and no chat report. The sender's request ID is taken once.
   */
  async receiveWebhook(keyHash:string,body:string,requestKey?:string):Promise<{status:'queued'|'batched'|'duplicate'|'skipped';reason?:string;dueAt?:string}>{
    return this.transaction(async tx=>{
      const row=(await tx.query<Schedule>('SELECT * FROM user_schedules WHERE webhook_key_hash=$1 FOR UPDATE',[keyHash])).rows[0]
      if(!row||!row.definition.webhook||row.status==='cancelled'||row.status==='completed'||!row.workspace_id) throw new ScheduleError('scheduleNotFound',404)
      if(row.status!=='active') throw new ScheduleError('scheduleNotActive',409)
      if(requestKey&&(await tx.query(`SELECT 1 FROM schedule_occurrences WHERE schedule_id=$1
        AND (trigger->'webhook'->'requests' @> $2::jsonb OR trigger->'webhook'->'requests' @> $3::jsonb) LIMIT 1`,
      [row.id,JSON.stringify([{key:requestKey}]),JSON.stringify([{keyHash:createHash('sha256').update(requestKey).digest('hex')}])])).rowCount) return {status:'duplicate' as const}
      const now=(await tx.query<{now:Date}>('SELECT clock_timestamp() now')).rows[0]!.now
      const request:WebhookRequest={at:now.toISOString(),body,...(requestKey?{key:requestKey}:{})}
      const batch=row.definition.webhook.batchMinutes
      if(batch>0){
        const open=(await tx.query<{id:string;n:number;bytes:number;due:Date}>(`SELECT id,jsonb_array_length(trigger->'webhook'->'requests')::int n,octet_length(trigger::text)::int bytes,next_retry_at due
          ${OPEN_WEBHOOK_WINDOW} FOR UPDATE`,[row.id,row.version])).rows[0]
        if(open&&open.n<WEBHOOK_BATCH_REQUESTS&&open.bytes+Buffer.byteLength(body)<=WEBHOOK_BATCH_BYTES){
          await tx.query(`UPDATE schedule_occurrences SET trigger=jsonb_set(trigger,'{webhook,requests}',(trigger->'webhook'->'requests')||$2::jsonb) WHERE id=$1`,[open.id,JSON.stringify([request])])
          await this.listChanged(tx,row.workspace_id)
          return {status:'batched' as const,dueAt:open.due.toISOString()}
        }
      }
      const {rows:[busy]}=await tx.query<{n:number}>(`SELECT count(*)::int n FROM schedule_occurrences WHERE schedule_id=$1 AND status IN ('pending','running')`,[row.id])
      const reason=busy.n>=(row.definition.maxConcurrent??1)?'concurrencyLimit':await this.dailyFull(tx,row)?'dailyRunLimit':null
      const due=new Date(now.getTime()+batch*60_000)
      const operation=requestKey?scheduleOperationId(row.id,`webhook:${requestKey}`):randomUUID()
      await tx.query(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,operation_id,next_retry_at,execution_decision,trigger,error,finished_at,reported_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$4,'execute',$8,$9,CASE WHEN $6='skipped' THEN $10::timestamptz END,CASE WHEN $6='skipped' THEN $10::timestamptz END)`,
        [randomUUID(),row.id,row.version,due,row.definition,reason?'skipped':'pending',operation,{webhook:{requests:[request]}},reason,now])
      await this.listChanged(tx,row.workspace_id)
      return reason?{status:'skipped' as const,reason}:{status:'queued' as const,dueAt:due.toISOString()}
    })
  }
  /**
   * 运行后发到 Slack: a finished run is claimed once (notified_at) and posted; a post that fails is logged, never retried
   * into a second post, and never changes the run.
   */
  private async notice(occurrenceId:string,status:'succeeded'|'failed'){
    if(!this.automation.notify)return
    try{
      const o=(await this.pool.query<Occurrence&{result:DispatchResult|null;runner:string;workspace_id:string|null;post_as_runner:boolean}>(`UPDATE schedule_occurrences o SET notified_at=clock_timestamp() FROM user_schedules s
        WHERE o.id=$1 AND s.id=o.schedule_id AND o.notified_at IS NULL AND o.definition ? 'notify' RETURNING o.*,COALESCE(s.run_as_user_id,s.owner_id) AS runner,s.workspace_id,
          (s.definition#>>'{notify,slack,postAsRunner}')='true' AS post_as_runner`,[occurrenceId])).rows[0]
      const slack=o?.definition.notify?.slack
      if(!o||!slack||!o.workspace_id)return
      // Posted through the current run-as person's Slack membership, else the creator's.
      await this.automation.notify({ownerId:o.runner,workspaceId:o.workspace_id,scheduleId:o.schedule_id,title:o.definition.title,channel:slack.channel,locale:slack.locale,status,
        task:o.result?.id?{id:o.result.id,identifier:o.result.identifier,title:o.result.title}:null,error:o.error,
        // Posting as a person follows the automation as it is now (who it runs as, whether they still want it), not the
        // definition the run was queued with.
        ...(slack.postAsRunner&&o.post_as_runner?{postAsRunner:true as const}:{}),...(slack.quiet?{quiet:true as const}:{})})
    }catch(error){console.error('schedule_notice_failed',error instanceof ScheduleError?error.code:error instanceof Error?error.name:'unknown')}
  }
  /** Whether maxRunsPerDay runs already started (or wait) today in the automation's time zone, not counting `except`. */
  private async dailyFull(tx:PoolClient,row:Schedule,except?:string){
    const max=row.definition.maxRunsPerDay
    if(!max)return false
    const {rows:[today]}=await tx.query<{n:number}>(`SELECT count(*)::int n FROM schedule_occurrences WHERE schedule_id=$1 AND ${COUNTED} AND id IS DISTINCT FROM $3::uuid
      AND created_at>=date_trunc('day',now() AT TIME ZONE $2) AT TIME ZONE $2`,[row.id,row.definition.timezone,except??null])
    return today.n>=max
  }
  async fail(claim:Pick<Occurrence,'id'|'lease_token'>,error:unknown){
    const terminal=error instanceof ScheduleError&&(error.status===403||error.code==='scheduleRecoveryExhausted')
    const code=error instanceof ScheduleError?error.code:'scheduleExecutionUnavailable'
    const failed=await this.transaction(async tx=>{
      const row=(await tx.query<Occurrence>(`UPDATE schedule_occurrences SET status=CASE WHEN $3 OR attempts >= $4 THEN 'failed' ELSE 'pending' END,error=$5,next_retry_at=$6,finished_at=CASE WHEN $3 OR attempts >= $4 THEN $7::timestamptz ELSE NULL END,lease_token=NULL,lease_until=NULL,report_next_at=$7 WHERE id=$1 AND status='running' AND lease_token=$2 RETURNING *`,[claim.id,claim.lease_token,terminal,MAX_ATTEMPTS,code,new Date(this.clock().getTime()+30_000),this.clock()])).rows[0]
      // The creator's authority no longer holds: stop the automation and say why, rather than fail every run after.
      if(row&&terminal&&AUTHORITY_LOST.has(code)){
        const paused=(await tx.query<Schedule>(`UPDATE user_schedules SET status='paused',next_at=NULL,disabled_reason=$2,version=version+1,updated_at=$3 WHERE id=$1 AND status='active' RETURNING *`,[row.schedule_id,code,this.clock()])).rows[0]
        if(paused){
          await tx.query(`UPDATE schedule_occurrences SET status='cancelled',error='scheduleChanged',lease_token=NULL,lease_until=NULL,finished_at=$2,reported_at=$2 WHERE schedule_id=$1 AND id<>$3 AND status IN ('pending','running')`,[paused.id,this.clock(),row.id])
          await this.listChanged(tx,paused.workspace_id)
        }
      }
      if(row?.event_id){const schedule=(await tx.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1',[row.schedule_id])).rows[0];if(schedule)await this.lockChat(tx,schedule);await this.retireEvent(tx,row.event_id)}
      return row?.status==='failed'?row:null
    })
    if(failed)await this.publishFailedReport(failed)
    if(failed)await this.notice(failed.id,'failed')
  }
  private async publishFailedReport(o:Occurrence){
    const row=(await this.pool.query<Schedule>('SELECT * FROM user_schedules WHERE id=$1',[o.schedule_id])).rows[0]
    if(!row)return
    const now=this.clock()
    try{await this.workspace(row.owner_id,row.workspace_id,()=>this.transaction(async tx=>{
      await tx.query('SELECT id FROM user_schedules WHERE id=$1 FOR UPDATE',[row.id])
      const current=(await tx.query<Occurrence>(`SELECT * FROM schedule_occurrences WHERE id=$1 AND status='failed' AND reported_at IS NULL AND report_next_at<=$2 FOR UPDATE SKIP LOCKED`,[o.id,now])).rows[0]
      if(current){
        await this.conversation(tx,{ownerId:row.owner_id,workspaceId:row.workspace_id,botId:row.bot_id})
        await this.lockChat(tx,row)
        await this.report(tx,row,current,'failed',null,current.error)
      }
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

/** A run_now request's occurrence identity: stable for one schedule and request, never a client-chosen ID. */
export function scheduleOperationId(scheduleId: string, requestId: string) {
  const hex = createHash('sha256').update(`schedule-run-now:${scheduleId}:${requestId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
function scheduleView(row: Schedule) {
  const { id, owner_id, workspace_id, bot_id, visibility, source_event_id, definition, request_definition, status, version, next_at } = row
  return { id, owner_id, workspace_id, bot_id, visibility, source_event_id, definition, request_definition, status, version, next_at }
}
