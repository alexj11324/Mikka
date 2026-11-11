import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { TurnOutcome } from 'eve/events'
import { telegramReplyTargets, type TelegramReplyTarget } from '../coordinator-events'
import { failureLine } from '../coordinator/refusal-line'
import { QUIET_REPLY } from '../attention/handoff'
import { readIssueMetadata } from '../issue-metadata'
import { splitTelegramText } from '../telegram/messages'
import type { InboxEvent } from '../push-reasons'
import chineseMessages from '../../messages/zh-CN.json'
import type { EveScope } from './scope'
import { eveStreamId } from './projection'

type Query = Pick<Pool, 'query'>
export interface EveOutcomeDelivery { sessionId:string; turnId:string; outcome:TurnOutcome }
interface StoredOutcome {
  sourceId:string; kind:InboxEvent['kind']; tier:InboxEvent['tier']; runId:string|null; issueId:string|null
  payload:Record<string,unknown>; message:Record<string,unknown>; issueOwner:string|null
  issueWorkspace:string|null; ownershipState:string|null; issueContent:Parameters<typeof readIssueMetadata>[0]
  personalCoordinator:boolean
}
interface DeliveryServices {
  telegram(threadId:string,text:string):Promise<void>
  push(ownerId:string,botId:string,text:string|null,events:readonly InboxEvent[]):Promise<void>
  safe(ownerId:string,text:string):Promise<void>
}
const defaults:DeliveryServices = {
  async telegram(threadId,text) { await (await import('../telegram/client')).postTelegramText(threadId,text) },
  async push(ownerId,botId,text,events) { await (await import('../coordinator/push-decision')).pushByDecision(ownerId,botId,text,events) },
  async safe(ownerId,text) { await (await import('../credentials/chat-guard')).assertCredentialSafeChat(ownerId,text) },
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const textOf=(message:Record<string,unknown>)=>typeof message.content==='string' ? message.content : Array.isArray(message.content)
  ? message.content.flatMap(part=>part&&typeof part==='object'&&part.type==='text'&&typeof part.text==='string'?[part.text]:[]).join('\n') : ''
const noReply=(message:Record<string,unknown>)=>Array.isArray(message.content)&&message.content.some(part=>part&&typeof part==='object'&&part.type==='tool-call'&&part.toolName==='no_reply')
const carriesCode=(source:StoredOutcome)=>source.kind==='matter_handoff'&&Boolean(source.payload.assessment&&typeof source.payload.assessment==='object'&&(source.payload.assessment as Record<string,unknown>).verificationCode)

/** Product notifications consume a committed native root projection, never run
 * an Agent or claim a Coordinator lease. Provider calls have no portable
 * idempotency key: dispatch is recorded first and an uncertain call stays final. */
export function createEveOutcomeDelivery(app:Query,workspace:Query,overrides:Partial<DeliveryServices>={}) {
  const services={...defaults,...overrides}
  async function load(scope:EveScope,input:EveOutcomeDelivery):Promise<StoredOutcome|null> {
    if(scope.surface!=='web')return null
    const {rows:[row]}=await app.query<StoredOutcome>(`SELECT e.id AS "sourceId",e.kind,e.tier,e."runId",e."issueId",e.payload,m.message,
      i."userId" AS "issueOwner",i."workspaceId" AS "issueWorkspace",i."ownershipState",i.content AS "issueContent",
      EXISTS(SELECT 1 FROM coordinator_bots cb WHERE cb."ownerId"=$2 AND cb."botId"=$3 AND cb."workspaceId"=$4) AS "personalCoordinator"
      FROM eve_sessions s JOIN bots b ON b.id=s.bot_id AND b."ownerId"=s.owner_id AND b."workspaceId"=s.workspace_id
      JOIN eve_turn_sources t ON t.session_id=s.session_id AND t.turn_id=$5
      JOIN coordinator_events e ON e.id=t.source_event_id AND e."userId"=s.owner_id AND e."botId"=s.bot_id AND e."deliveredAt" IS NOT NULL
      JOIN eve_projection_receipts p ON p.session_id=s.session_id AND p.event_key=t.turn_id
      JOIN coordinator_messages m ON m."userId"=s.owner_id AND m."botId"=s.bot_id AND m.message->>'mikkaStreamId'=$6 AND m.message->>'role'='assistant'
      LEFT JOIN issues i ON i.id=e."issueId"
      WHERE s.session_id=$1 AND s.owner_id=$2 AND s.bot_id=$3 AND s.workspace_id=$4 AND s.surface='web'
      ORDER BY m.position DESC LIMIT 1`,[input.sessionId,scope.ownerId,scope.botId,scope.workspaceId,input.turnId,eveStreamId(input.sessionId,input.turnId)])
    if(!row||row.payload.source==='schedule_due')return null
    const storedOutcome=row.message.mikkaStopped===true?'cancelled':typeof row.message.mikkaFailure==='string'?'failed':'completed'
    if(storedOutcome!==input.outcome)return null
    const {rows:[member]}=await workspace.query<{kind:string;userId:string}>(`SELECT w.kind,w."userId" FROM mikka_workspaces w
      JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$1 AND m.status='active'
      WHERE w.id=$2 AND (w.kind='team' OR (w.kind='personal' AND w."userId"=$1))`,[scope.ownerId,scope.workspaceId])
    if(!member)return null
    row.personalCoordinator=row.personalCoordinator&&member.kind==='personal'&&member.userId===scope.ownerId
    return row
  }
  async function telegramAllowed(scope:EveScope,source:StoredOutcome,target:TelegramReplyTarget) {
    if(!source.personalCoordinator)return false
    if(source.issueId&&(!source.issueOwner||source.ownershipState!=='bound'||source.issueWorkspace!==scope.workspaceId||readIssueMetadata(source.issueContent).deletedAt))return false
    const {rowCount}=await app.query(`SELECT 1 FROM telegram_links l JOIN telegram_conversations c ON c."userId"=l."userId"
      WHERE l."userId"=$1 AND l."telegramUserId"=$2 AND c."threadId"=$3`,[scope.ownerId,target.telegramUserId,target.threadId])
    return Boolean(rowCount)
  }
  async function claim(scope:EveScope,input:EveOutcomeDelivery,source:StoredOutcome,kind:'telegram'|'phone',targetKey:string,index:number,body:string|null) {
    const requestDigest=digest([scope.ownerId,scope.botId,scope.workspaceId,source.sourceId,input.outcome,kind,targetKey,index,body])
    const values=[input.sessionId,input.turnId,kind,targetKey,index,scope.ownerId,scope.botId,scope.workspaceId,source.sourceId,requestDigest]
    const inserted=await app.query(`INSERT INTO eve_outcome_deliveries(session_id,turn_id,kind,target_key,chunk_index,owner_id,bot_id,workspace_id,source_event_id,request_digest,status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'dispatching') ON CONFLICT DO NOTHING RETURNING status`,values)
    if(inserted.rowCount)return 'dispatch' as const
    const {rows:[prior]}=await app.query<{request_digest:string;status:string}>(`SELECT request_digest,status FROM eve_outcome_deliveries
      WHERE session_id=$1 AND turn_id=$2 AND kind=$3 AND target_key=$4 AND chunk_index=$5`,values.slice(0,5))
    if(!prior||prior.request_digest!==requestDigest)throw new Error('operationBindingConflict')
    return prior.status==='completed'?'completed' as const:'uncertain' as const
  }
  async function finish(input:EveOutcomeDelivery,kind:'telegram'|'phone',target:string,index:number,status:'completed'|'unknown') {
    await app.query(`UPDATE eve_outcome_deliveries SET status=$6,finished_at=now() WHERE session_id=$1 AND turn_id=$2 AND kind=$3 AND target_key=$4 AND chunk_index=$5 AND status='dispatching'`,[input.sessionId,input.turnId,kind,target,index,status])
  }
  return async function deliver(scope:EveScope,input:EveOutcomeDelivery):Promise<void> {
    if(input.outcome==='cancelled')return
    const source=await load(scope,input)
    if(!source)return
    const text=textOf(source.message)
    if(noReply(source.message)||text.trim()===QUIET_REPLY)return
    const failure=input.outcome==='failed'?failureLine(typeof source.message.mikkaFailure==='string'?source.message.mikkaFailure:null):null
    if(input.outcome==='failed'&&!failure)return
    const reply=failure??text
    if(reply)await services.safe(scope.ownerId,reply)
    const code=carriesCode(source)
    const targets=code?[]:telegramReplyTargets([source])
    for(const target of targets) {
      const targetKey=digest([target.threadId,target.telegramUserId])
      const chunks=splitTelegramText(reply.trim()?reply:chineseMessages.Coordinator.failedTitle)
      for(const [index,chunk]of chunks.entries()) {
        const current=await load(scope,input)
        if(!current||current.sourceId!==source.sourceId||!await telegramAllowed(scope,current,target))break
        const claimed=await claim(scope,input,source,'telegram',targetKey,index,chunk)
        if(claimed==='uncertain')break
        if(claimed==='completed')continue
        try { await services.telegram(target.threadId,chunk) }
        catch(error) { await finish(input,'telegram',targetKey,index,'unknown');console.error('Native outcome delivery unavailable',{channel:'telegram',name:error instanceof Error?error.name:'unknown'});break }
        await finish(input,'telegram',targetKey,index,'completed')
      }
    }
    // Keep the existing Decisions call and its settings/mute/task/phone-session
    // checks. A verification code is described, never quoted to the judge or lock screen.
    if(reply.trim()) {
      const current=await load(scope,input)
      if(!current||current.sourceId!==source.sourceId)return
      const body=code?null:reply
      if(await claim(scope,input,source,'phone','owner',0,body)!=='dispatch')return
      try { await services.push(scope.ownerId,scope.botId,body,[{kind:source.kind,tier:source.tier,runId:source.runId,issueId:source.issueId}]) }
      catch(error) { await finish(input,'phone','owner',0,'unknown');console.error('Native outcome delivery unavailable',{channel:'phone',name:error instanceof Error?error.name:'unknown'});return }
      await finish(input,'phone','owner',0,'completed')
    }
  }
}

/** Called on the app host after committing a root's compatibility projection. */
export async function deliverEveOutcome(scope:EveScope,input:EveOutcomeDelivery) {
  const [{pool},{workspacePool}]=await Promise.all([import('../db'),import('../workspace-db')])
  await createEveOutcomeDelivery(pool,workspacePool)(scope,input)
}
