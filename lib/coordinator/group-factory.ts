import type { Pool, PoolClient } from 'pg'
import { createHash } from 'node:crypto'
import { groupListChanged } from '@/lib/live/lists'
import { groupChatChanged } from '@/lib/live/groups'
import { factoryEventId } from '@/lib/factory/event-id'
import type { GroupRuntime, GroupReply } from './group-turns'
import type { GroupTaskReference } from './group-routing'
import { recordGroupTraceEvent } from './group-decision-trace'
import { recordGroupFeedback } from './group-decision-feedback'
import { workspaceLink } from '@/components/workspace/workspace-navigation'
import { withBasePath } from '@/lib/base-path'
import { ActionFailureError } from '@/lib/action-error'
import { groupCopy, readGroupLocale, type GroupLocale } from './group-copy'
import { runArtifactSubmissions } from '@/lib/artifacts/run-submissions'
import type { RunModel } from '@/lib/computer/run-model'

type Scope = Parameters<NonNullable<GroupRuntime['delegate']>>[0]
type Query = Pick<PoolClient,'query'>
type TaskState = { taskId:string|null; issueId:string; status:string; stage:string; revision:number; runId:string|null; requestEpoch:string|null; acceptedDeliverable?:boolean; mergedCandidate?:boolean; artifacts?:{id:string}[] }

// A no-repository deliverable is terminal at approval/passed. Only the actual
// acceptance ledger for the current candidate and epoch proves completion;
// ordinary approval/passed or a model-authored output field is insufficient.
const acceptedDeliverableSql=`(t.stage='approval' AND t.status='passed' AND EXISTS (
  SELECT 1 FROM factory_deliverable_acceptances accepted
  JOIN factory_candidates candidate ON candidate.id=accepted."candidateId" AND candidate."taskId"=accepted."taskId"
  JOIN factory_attempts approved ON approved.id=t."attemptId" AND approved."taskId"=t.id
  WHERE accepted."taskId"=t.id AND accepted."candidateId"=t."candidateId" AND accepted."userId"=t."userId"
    AND candidate.kind IN ('report','deliverable')
    AND approved.output->>'deliverableAcceptanceId'=accepted.id::text
    AND approved.output->>'requestEpoch'=t."sourceEventId"::text))`
const mergedCandidateSql=`(t.stage='publish' AND t.status='passed' AND EXISTS (
  SELECT 1 FROM factory_merges merged
  JOIN factory_candidates candidate ON candidate.id=merged."candidateId" AND candidate."taskId"=merged."taskId"
  JOIN factory_attempts published ON published.id=t."attemptId" AND published."taskId"=t.id
  WHERE merged."taskId"=t.id AND merged."candidateId"=t."candidateId" AND merged."userId"=t."userId"
    AND merged.status='merged' AND candidate.kind='repository'
    AND published.output->>'mergeId'=merged.id::text
    AND published.output->>'requestEpoch'=t."sourceEventId"::text))`
const taskSucceeded=(task:TaskState)=>task.status==='passed' && (task.stage==='monitor' || task.acceptedDeliverable===true || task.mergedCandidate===true)

/** Only tasks previously bound by this authenticated participant enter the model's allowlist. */
export async function groupTaskReferences(client:Query, scope:{userId:string;conversationId:string}):Promise<GroupTaskReference[]> {
  return (await client.query<GroupTaskReference>(`SELECT b."issueId",b."reporterId",i.title,t.id AS "taskId",
    COALESCE(t.status,'pending') AS status,a."runId",t."sourceEventId" AS "requestEpoch"
    FROM group_task_bindings b JOIN issues i ON i.id=b."issueId"
    LEFT JOIN LATERAL (SELECT * FROM factory_tasks WHERE "issueId"=b."issueId" AND "userId"=b."userId" AND "botId"=b."executionBotId" ORDER BY "createdAt" DESC LIMIT 1) t ON true
    LEFT JOIN factory_attempts a ON a.id=t."attemptId"
    WHERE b."conversationId"=$1 AND b."userId"=$2 ORDER BY b."createdAt" DESC LIMIT 20`,[scope.conversationId,scope.userId])).rows
}

export function groupTaskReport(task:TaskState, prefix?:string, locale:GroupLocale='zh-CN'):GroupReply {
  const copy=groupCopy(locale)
  const href=(place:Parameters<typeof workspaceLink>[0])=>withBasePath(`${locale==='en'?'/en':''}${workspaceLink(place)}`)
  const link=href({issue:task.issueId})
  const thread=task.runId ? href({issue:task.issueId,thread:task.runId}) : null
  const stage:Record<string,string>=copy.stage
  const status:Record<string,string>=copy.status
  return {text:[prefix ?? (task.acceptedDeliverable ? copy.accepted : task.mergedCandidate ? copy.merged : copy.state.replace('{stage}',stage[task.stage] ?? copy.awaitingDispatch).replace('{status}',status[task.status] ?? status.pending)),
    `[${copy.task}](${link})`,...(thread?[`[${copy.thread}](${thread}) · [${copy.evidence}](${thread})`]:[]),
    ...(task.artifacts ?? []).map((artifact,i)=>`[${copy.artifact.replace('{number}',String(i+1))}](${href({issue:task.issueId,artifact:artifact.id})})`),
    ...(task.stage==='approval' && ['pending','waiting','blocked'].includes(task.status) ? [copy.approvalRequired]:[])].join('\n'),mentions:[]}
}

/** All error text is host-authored. Provider errors, private prompts and raw credentials never enter the group. */
export function groupExecutionRemedy(reason:string,locale:GroupLocale='zh-CN'):string {
  const copy=groupCopy(locale)
  if (['repositoryRequired','agentRepoMissing','repositoryNotFound'].includes(reason)) return copy.repositoryRemedy
  if (['noDevice','machineUnavailable','deviceOffline','agentNoDevice','cloudComputerUnavailable','cloudNotConfigured','cloudTemporarilyUnavailable'].includes(reason)) return copy.runtimeRemedy
  if (reason==='task_tool_disabled') return copy.toolRemedy
  return copy.authorizationRemedy
}

export type GroupFactoryAdapters = {
  authorize(scope:Scope):Promise<void>
  executionBot(scope:Scope):Promise<{botId:string;reporterOwnerId:string;repository:string|null}>
  create(userId:string,eventId:string,title:string):Promise<string>
  dispatch(userId:string,input:{issueId:string;repo?:string;note:string;requestKey:string;sourceEventId:string},botId:string):Promise<{runId?:string;thread?:string;status?:string;error?:string}>
  latest(userId:string,issueId:string):Promise<{id:string}|null>
  continuation(userId:string,runId:string,text:string,eventId:string):Promise<unknown>
  stop(userId:string,task:TaskState,botId:string,eventId:string):Promise<void>
}

/** Host-origin message ID is the idempotency key. Decision IDs never create authority. */
export async function delegateGroupTask(client:PoolClient, scope:Scope, adapters?:GroupFactoryAdapters):Promise<GroupReply> {
  const runtime=adapters ?? await productionAdapters()
  await runtime.authorize(scope)
  const locale=await readGroupLocale(client,scope.userId)
  const copy=groupCopy(locale)
  if (scope.reporter.memberType !== 'bot') {
    const reply={text:copy.chooseBot,mentions:[]}
    await traceDelegation(client,scope,reply);return reply
  }
  const {operation}=scope.delegation
  if ((operation==='create' || operation==='continue') && scope.reporter.executionReason==='task_tool_disabled') {
    const reply={text:copy.notStarted.replace('{remedy}',groupExecutionRemedy('task_tool_disabled',locale)),mentions:[]}
    await traceDelegation(client,scope,reply);return reply
  }
  const {rows:[existing]}=await client.query(`SELECT * FROM group_task_receipts WHERE "messageId"=$1`,[scope.messageId])
  if (existing && (existing.userId!==scope.userId || existing.conversationId!==scope.conversationId || existing.reporterId!==scope.reporter.id || existing.operation!==operation || scope.delegation.issueId && existing.issueId!==scope.delegation.issueId)) throw Error('group_task_replay_mismatch')
  if (existing?.result) {
    await traceDelegation(client,scope,existing.result)
    return existing.result
  }
  await client.query(`INSERT INTO group_task_receipts ("messageId","conversationId","userId","reporterId",operation,"issueId") VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[scope.messageId,scope.conversationId,scope.userId,scope.reporter.id,operation,scope.delegation.issueId])
  let originMessageId:string|undefined
  // Provider/Factory work happens before this short transaction. The durable
  // receipt and its counted event commit together, including a silent success.
  const finish=async(reply:GroupReply)=>{
    await client.query('BEGIN')
    try {
      await client.query(`UPDATE group_task_receipts SET result=$2 WHERE "messageId"=$1`,[scope.messageId,JSON.stringify(reply)])
      await traceDelegation(client,scope,reply)
      if (operation==='stop' && originMessageId && reply.taskReceipt?.taskId && reply.taskReceipt.outcome==='stopped') {
        await recordGroupFeedback(client,{conversationId:scope.conversationId,messageId:originMessageId,userId:scope.userId,source:'human_cancellation',kind:'cancelled_task',targetId:scope.reporter.id,sourceMessageId:scope.messageId})
        await recordGroupTraceEvent(client,originMessageId,{id:`task-stop:${reply.taskReceipt.taskId}:${reply.taskReceipt.requestEpoch}`,type:'task_result',memberId:scope.reporter.id,...(reply.taskReceipt.taskId?{taskId:reply.taskReceipt.taskId}:{}),...(reply.taskReceipt.runId?{runId:reply.taskReceipt.runId}:{}),outcome:'stopped'})
        await client.query(`UPDATE group_turns SET trace=trace || jsonb_build_object('taskFinishedAt',COALESCE(trace->>'taskFinishedAt',now()::text)) WHERE "messageId"=$1`,[originMessageId])
      }
      await client.query('COMMIT')
      return reply
    } catch(error) {await client.query('ROLLBACK');throw error}
  }
  let issueId=scope.delegation.issueId ?? existing?.issueId as string|undefined
  let botId:string, repository:string|null=null
  if (operation==='create') {
    if (!scope.reporter.executionAvailable) return finish({text:copy.notStarted.replace('{remedy}',groupExecutionRemedy(scope.reporter.executionReason ?? 'execution_unavailable',locale)),mentions:[]})
    const execution=await runtime.executionBot(scope);botId=execution.botId;repository=execution.repository
    const intakeId=factoryEventId('group-intake',scope.messageId)
    await sourceEvent(client,{id:intakeId,userId:scope.userId,botId,issueId:null,text:scope.text,conversationId:scope.conversationId,messageId:scope.messageId})
    issueId=await runtime.create(scope.userId,intakeId,scope.text.trim().slice(0,200))
    await client.query(`INSERT INTO group_task_bindings ("conversationId","issueId","userId","reporterId","reporterOwnerId","reporterType","executionBotId","sourceMessageId","sourceEventId") VALUES($1,$2,$3,$4,$8,'bot',$5,$6,$7) ON CONFLICT DO NOTHING`,[scope.conversationId,issueId,scope.userId,scope.reporter.id,botId,scope.messageId,factoryEventId('group-delegate',scope.messageId),execution.reporterOwnerId])
    await client.query(`UPDATE group_task_receipts SET "issueId"=$2 WHERE "messageId"=$1`,[scope.messageId,issueId])
  } else {
    const {rows:[binding]}=await client.query(`SELECT * FROM group_task_bindings WHERE "conversationId"=$1 AND "issueId"=$2 AND "userId"=$3 AND "reporterId"=$4`,[scope.conversationId,issueId,scope.userId,scope.reporter.id])
    if (!binding) throw Error('group_task_not_authorized')
    botId=binding.executionBotId
    originMessageId=binding.sourceMessageId
  }
  if (!issueId) throw Error('group_task_missing')
  const eventId=factoryEventId('group-delegate',scope.messageId)
  let task=await readTask(client,scope.userId,issueId,botId)
  const reported=async()=>{await client.query(`UPDATE group_task_bindings SET "lastReportedRevision"=GREATEST("lastReportedRevision",$3) WHERE "conversationId"=$1 AND "issueId"=$2`,[scope.conversationId,issueId,task.revision])}
  if (operation==='status') {await reported();return finish(groupTaskReport(task,undefined,locale))}
  if (operation==='stop') {
    // Factory cancellation commits its stop signals and token revocation with
    // the task state. Recover that confirmed result if the group receipt was
    // interrupted; applying another cancel to a terminal task is invalid.
    if (task.taskId && !['cancelled','revoked'].includes(task.status)) await runtime.stop(scope.userId,task,botId,eventId)
    task=await readTask(client,scope.userId,issueId,botId)
    await reported()
    const confirmed=Boolean(task.taskId && ['cancelled','revoked'].includes(task.status))
    return finish({...groupTaskReport(task,confirmed?copy.stopRequested:copy.nothingToStop,locale),taskReceipt:{taskId:task.taskId,issueId,runId:task.runId,requestEpoch:task.requestEpoch,outcome:confirmed?'stopped':'blocked',reportTiming:'now'}})
  }
  const previous=operation==='continue' ? await runtime.latest(scope.userId,issueId) : null
  await sourceEvent(client,{id:eventId,userId:scope.userId,botId,issueId,text:scope.text,conversationId:scope.conversationId,messageId:scope.messageId,...(previous?{previousRunId:previous.id}:{})})
  // A committed Factory dispatch is stronger evidence than an interrupted group worker.
  // Replay reads it instead of injecting another message into the same thread.
  if (!(task.requestEpoch===eventId && task.runId)) {
    await runtime.authorize(scope)
    const result=await runtime.dispatch(scope.userId,{issueId,...(repository?{repo:repository}:{}),note:scope.text,requestKey:`group:${scope.messageId}`,sourceEventId:eventId},botId)
    if (result.error) {
      task=await readTask(client,scope.userId,issueId,botId);await reported()
      return finish({...groupTaskReport(task,copy.newRunNotStarted.replace('{remedy}',groupExecutionRemedy(result.error,locale)),locale),taskReceipt:{taskId:task.taskId,issueId,runId:task.runId,requestEpoch:task.requestEpoch,outcome:'blocked',reportTiming:'now'}})
    }
    if (!result.runId) throw Error('group_task_dispatch_unconfirmed')
    if (result.thread==='message' && result.status==='messageSent') await runtime.continuation(scope.userId,result.runId,scope.text,eventId)
    task=await readTask(client,scope.userId,issueId,botId)
    if (!task.taskId) throw Error('group_task_dispatch_unconfirmed')
    task={...task,runId:task.runId ?? result.runId}
  }
  await client.query(`UPDATE group_task_bindings SET "sourceEventId"=$3,"sourceMessageId"=$4,"lastReportedRevision"=$5 WHERE "conversationId"=$1 AND "issueId"=$2`,[scope.conversationId,issueId,eventId,scope.messageId,task.revision])
  const reportTiming=scope.delegation.reportTiming ?? 'now'
  const report=groupTaskReport(task,operation==='continue' ? copy.continued : copy.created,locale)
  return finish({...report,...(reportTiming==='on_completion'?{text:''}:{}),taskReceipt:{taskId:task.taskId,issueId,runId:task.runId,requestEpoch:task.requestEpoch,outcome:'succeeded',reportTiming}})
}

/** Only host-confirmed task work is a delegation. Status reads and stops are
 * separate operations even though the Decision uses the same task adapter. */
async function traceDelegation(client:Query,scope:Scope,reply:GroupReply) {
  if (!['create','continue'].includes(scope.delegation.operation)) return
  const receipt=reply.taskReceipt
  const succeeded=receipt?.outcome==='succeeded' && Boolean(receipt.taskId && receipt.runId && receipt.requestEpoch)
  await recordGroupTraceEvent(client,scope.messageId,{id:`delegate:${scope.messageId}`,type:'delegate',memberId:scope.reporter.id,
    ...(receipt?.taskId?{taskId:receipt.taskId}:{}),...(receipt?.runId?{runId:receipt.runId}:{}),outcome:succeeded?'succeeded':'blocked'})
}

async function sourceEvent(client:Query,input:{id:string;userId:string;botId:string|null;issueId:string|null;text:string;conversationId:string;messageId:string;previousRunId?:string}) {
  await client.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt") VALUES($1,$2,$3,$4,'user_message',$5,$6,'background',now()) ON CONFLICT DO NOTHING`,[input.id,input.userId,input.botId,input.issueId,`group-task:${input.id}`,JSON.stringify({text:input.text,source:input.previousRunId?'thread_continuation':'group_delegation',conversationId:input.conversationId,messageId:input.messageId,postedToChat:true,...(input.previousRunId?{previousRunId:input.previousRunId}:{})})])
}

async function readTask(client:Query,userId:string,issueId:string,botId:string):Promise<TaskState> {
  const {rows:[row]}=await client.query<TaskState & {artifactRunIds:string[]}>(`SELECT t.id AS "taskId",t."issueId",t.status,t.stage,t.revision,
    COALESCE(a."runId",(SELECT produced."runId" FROM factory_candidates produced WHERE produced.id=t."candidateId" AND produced."taskId"=t.id)) AS "runId",
    t."sourceEventId" AS "requestEpoch",${acceptedDeliverableSql} AS "acceptedDeliverable",${mergedCandidateSql} AS "mergedCandidate",
    ARRAY(SELECT DISTINCT fa."runId" FROM factory_attempts fa JOIN agent_runs r ON r.id=fa."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
      WHERE fa."taskId"=t.id AND fa.output->>'requestEpoch'=t."sourceEventId"::text) AS "artifactRunIds"
    FROM factory_tasks t LEFT JOIN factory_attempts a ON a.id=t."attemptId" WHERE t."userId"=$1 AND t."issueId"=$2 AND t."botId"=$3 ORDER BY t."createdAt" DESC LIMIT 1`,[userId,issueId,botId])
  if (!row) return {taskId:null,issueId,status:'pending',stage:'execute',revision:0,runId:null,requestEpoch:null}
  const {artifactRunIds,...task}=row
  const artifacts=await runArtifactSubmissions(client,userId,artifactRunIds)
  return {...task,artifacts:artifacts.slice(-10).reverse().map(({id})=>({id}))}
}

/** Current workspace and group membership are checked again at the execution boundary.
 * Group identities are text (people need not have UUID IDs), while Bot IDs are UUIDs. */
export async function authorizeGroupFactoryActor(client:Query,scope:Pick<Scope,'userId'|'workspaceId'|'conversationId'|'reporter'>,
  authorizeWorkspace:(userId:string,workspaceId:string)=>Promise<unknown>=async(userId,workspaceId)=>{
    return (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(userId,workspaceId)
  }):Promise<void> {
  await authorizeWorkspace(scope.userId,scope.workspaceId)
  const {rows:[member]}=await client.query(`SELECT b."ownerId" FROM conversations c JOIN conversation_members u ON u."conversationId"=c.id AND u."memberType"='user' AND u."memberId"=$2 AND u."leftAt" IS NULL JOIN conversation_members m ON m."conversationId"=c.id AND m."memberType"='bot' AND m."memberId"=$3 AND m."leftAt" IS NULL JOIN bots b ON b.id::text=m."memberId" AND b."workspaceId"=c."workspaceId" AND b."archivedAt" IS NULL WHERE c.id=$1 AND c."workspaceId"=$4`,[scope.conversationId,scope.userId,scope.reporter.id,scope.workspaceId])
  if (!member?.ownerId) throw Error('group_task_not_authorized')
  await authorizeWorkspace(member.ownerId,scope.workspaceId)
}

async function productionAdapters():Promise<GroupFactoryAdapters> {
  const {pool}=await import('@/lib/db')
  return {
    authorize:scope=>authorizeGroupFactoryActor(pool,scope),
    async executionBot(scope) {
      const {rows:[bot]}=await pool.query(`SELECT id,"ownerId",repository FROM bots WHERE id=$1 AND "workspaceId"=$2 AND "archivedAt" IS NULL`,[scope.reporter.id,scope.workspaceId])
      if (!bot) throw Error('group_task_not_authorized')
      // A shared Bot is the reporter. Execution stays on the requester's own
      // Coordinator/resources, never impersonating the reporter's owner.
      const botId=bot.ownerId===scope.userId ? bot.id : await (await import('./coordinator-bot')).chatBotId(scope.userId,null,scope.workspaceId)
      return {botId,reporterOwnerId:bot.ownerId,repository:bot.repository}
    },
    async create(userId,sourceEventId,title) { return (await (await import('./issue-create')).createIssueFromRequest(userId,{sourceEventId,title})).issueId },
    async dispatch(userId,input,botId) {
      const {latestTaskRun}=await import('@/lib/thread-dispatch')
      const previous=await latestTaskRun(pool,userId,input.issueId)
      if (input.repo || previous?.remoteUrl) return (await import('@/workflows/coordinator/steps')).dispatchRun(userId,{...input,repo:input.repo ?? previous!.remoteUrl!},undefined,botId)
      return dispatchStandaloneTask(userId,input,botId)
    },
    async latest(userId,issueId) { return (await import('@/lib/thread-dispatch')).latestTaskRun(pool,userId,issueId) },
    async continuation(userId,runId,text,eventId) { return (await import('@/lib/factory/request-epoch')).continueActiveFactoryRequest(pool,userId,runId,text,eventId) },
    async stop(userId,task,botId,eventId) {
      const {factoryRuntimeForBot}=await import('@/lib/factory/runtime')
      const {factoryBinding}=await import('@/lib/factory/dispatch')
      const store=factoryRuntimeForBot(botId).store
      const current=await store.read(userId,task.taskId!)
      await store.apply(userId,factoryBinding(current.task),eventId,{action:'cancel',reason:'The authenticated group participant requested cancellation.'})
      if (task.runId) {
        try {await (await import('@/lib/agent-runs')).requestRunStop(userId,task.runId)}
        catch(error) {if (!(error instanceof ActionFailureError && error.code==='runChainEnded')) throw error}
      }
    },
  }
}

/** A standalone report/file still follows Factory, but does not invent a Git
 * repository. Reuse the existing Bot computer and Task thread admission. */
async function dispatchStandaloneTask(userId:string,input:Parameters<GroupFactoryAdapters['dispatch']>[1],botId:string) {
  const {pool}=await import('@/lib/db')
  const {dispatchToTask}=await import('@/lib/thread-dispatch')
  return dispatchToTask(userId,input.issueId,{note:input.note,sourceEventId:input.sourceEventId,start:async(previous,note)=>{
    const {executionWorkspace}=await import('@/lib/execution-settings')
    const workspaceId=await executionWorkspace(userId,botId)
    const {bindAgentToConnection}=await import('@/lib/model-dispatch')
    const {resolveAgentProfileDispatch}=await import('@/lib/factory/agent-profile')
    const {ensureBotCloudRuntime}=await import('@/lib/computer/auto-runtime')
    const {latestThreadRunModel}=await import('@/lib/computer/run-model')
    const kept=previous ? await latestThreadRunModel(pool,userId,input.issueId,previous.agentId) : null
    if (previous && !kept) return {error:'threadModelUnavailable' as const}
    const choice=previous ? null : await resolveAgentProfileDispatch(pool,{ownerId:userId,workspaceId,botId},{issueId:input.issueId,stage:'execute',note,location:'cloud',cloudPurpose:'desktop'})
    const target=choice?.target
    if (target && target.kind!=='cloud') return {error:'machineUnavailable' as const}
    const harness=previous?.harness ?? (target?.kind==='cloud' ? target.harness : null)
    if (harness!=='codex' && harness!=='claude_code') return {error:'machineUnavailable' as const}
    const runtime=await ensureBotCloudRuntime(pool,{userId,workspaceId},botId,{harness})
    if (!runtime) return {error:'cloudComputerUnavailable' as const}
    const source=target?.kind==='cloud' ? target.entry.source : null
    const subscriptionBindingId=source?.kind==='subscription' && target?.kind==='cloud' ? await bindAgentToConnection(pool,{ownerId:userId,workspaceId},runtime.agentId,harness,source.connectionId,target.model) : undefined
    const selection:RunModel|null=kept ?? (target?.kind==='cloud' ? {model:target.model,agentProfile:choice?.agentProfile,modelDispatch:{mode:choice?.selectionMode ?? 'preference',location:'cloud',entry:target.entry,...(target.routing?{routing:target.routing}:{})},...(subscriptionBindingId?{subscriptionBindingId}:{}),...(source?.kind==='api_key'?{apiKeyId:source.keyId}:{})} : null)
    if (!selection) return {error:'threadModelUnavailable' as const}
    const {dispatchComputerTask}=await import('@/workflows/coordinator/steps')
    return dispatchComputerTask(userId,{botId,issueId:input.issueId,harness,note,...selection,sourceEventId:input.sourceEventId,factoryBotId:botId,...(previous?{threadRunId:previous.id}:{}),...(previous?.readOnly?{readOnly:true}:{})},`group:${input.sourceEventId}`)
  }})
}

/** Bound tasks with a reportable revision their group has not been told (b: group_task_bindings, t: factory_tasks). */
export const pendingTaskReportsSql=`FROM group_task_bindings b
    JOIN factory_tasks t ON t."issueId"=b."issueId" AND t."userId"=b."userId" AND t."botId"=b."executionBotId" AND t."sourceEventId"=b."sourceEventId"
    WHERE t.revision>b."lastReportedRevision" AND (t.status IN ('failed','blocked','waiting','cancelled','revoked') OR (t.stage='approval' AND t.status='pending') OR (t.status='passed' AND t.stage='monitor') OR ${acceptedDeliverableSql} OR ${mergedCandidateSql})`

/** The existing minute worker and group reads publish confirmed lifecycle
 * milestones directly. No extra model is allowed to suppress a real result. */
export async function groupsWithPendingTaskReports(client:Query):Promise<string[]> {
  return (await client.query<{conversationId:string}>(`SELECT DISTINCT b."conversationId" ${pendingTaskReportsSql} LIMIT 20`)).rows.map(row=>row.conversationId)
}

export async function reconcileGroupTaskReports(conversationId:string, dependencies?:{pool:Pool;authorize:GroupFactoryAdapters['authorize']}):Promise<number> {
  const pool=dependencies?.pool ?? (await import('@/lib/db')).pool
  const authorize=dependencies?.authorize ?? (await productionAdapters()).authorize
  const client=await pool.connect()
  let count=0
  try {
    const {rows:bindings}=await client.query(`SELECT b.*,c."workspaceId" FROM group_task_bindings b JOIN conversations c ON c.id=b."conversationId" WHERE b."conversationId"=$1`,[conversationId])
    for (const binding of bindings) {
      const task=await readTask(client,binding.userId,binding.issueId,binding.executionBotId)
      if (!task.taskId || task.requestEpoch!==binding.sourceEventId || task.revision<=binding.lastReportedRevision || !(['failed','blocked','waiting','cancelled','revoked'].includes(task.status) || task.stage==='approval' && task.status==='pending' || taskSucceeded(task))) continue
      try { await authorize({userId:binding.userId,workspaceId:binding.workspaceId,conversationId,messageId:binding.sourceMessageId,reporter:{id:binding.reporterId,name:'',description:'',memberType:'bot'},text:'',delegation:{operation:'status',issueId:binding.issueId}}) }
      catch { continue }
      await client.query('BEGIN')
      try {
        await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE',[conversationId])
        const {rows:[current]}=await client.query(`SELECT "lastReportedRevision","sourceEventId" FROM group_task_bindings WHERE "conversationId"=$1 AND "issueId"=$2 FOR UPDATE`,[conversationId,binding.issueId])
        if (!current || current.lastReportedRevision>=task.revision || current.sourceEventId!==task.requestEpoch) {await client.query('ROLLBACK');continue}
        const {rows:[fenced]}=await client.query(`SELECT revision,"sourceEventId" FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR SHARE`,[task.taskId,binding.userId])
        if (!fenced || fenced.revision!==task.revision || fenced.sourceEventId!==task.requestEpoch) {await client.query('ROLLBACK');continue}
        // Membership changes take this conversation lock. Never post after either participant left.
        const {rows:[valid]}=await client.query(`SELECT 1 FROM conversation_members u JOIN conversation_members b ON b."conversationId"=u."conversationId" WHERE u."conversationId"=$1 AND u."memberType"='user' AND u."memberId"=$2 AND u."leftAt" IS NULL AND b."memberType"='bot' AND b."memberId"=$3 AND b."leftAt" IS NULL`,[conversationId,binding.userId,binding.reporterId])
        if (!valid) {await client.query('ROLLBACK');continue}
        const {rows:[position]}=await client.query(`UPDATE conversations SET "lastPosition"="lastPosition"+1 WHERE id=$1 RETURNING "lastPosition"`,[conversationId])
        const id=factoryEventId('group-task-report',`${conversationId}:${task.taskId}:${task.revision}`)
        const text=groupTaskReport(task,undefined,await readGroupLocale(client,binding.userId)).text
        const inserted=await client.query(`INSERT INTO conversation_messages (id,"conversationId",position,"authorType","authorId",body,mentions,"replyToId") VALUES($1,$2,$3,'bot',$4,$5,'[]',$6) ON CONFLICT DO NOTHING RETURNING id`,[id,conversationId,position.lastPosition,binding.reporterId,text,binding.sourceMessageId])
        if (inserted.rowCount) {
          await groupListChanged(client, conversationId)
          await groupChatChanged(client, conversationId)
          await recordGroupTraceEvent(client,binding.sourceMessageId,{id:`publish:${id}`,type:'publish',memberId:binding.reporterId,taskId:task.taskId,runId:task.runId ?? undefined,contentDigest:createHash('sha256').update(text.trim()).digest('hex')})
          const outcome=taskSucceeded(task) ? 'succeeded' : ['cancelled','revoked'].includes(task.status) ? 'stopped' : task.status==='failed' ? 'failed' : 'blocked'
          await recordGroupTraceEvent(client,binding.sourceMessageId,{id:`task-result:${id}`,type:'task_result',memberId:binding.reporterId,taskId:task.taskId,runId:task.runId ?? undefined,outcome})
          if (outcome==='succeeded' || outcome==='stopped') await client.query(`UPDATE group_turns SET trace=trace || jsonb_build_object('taskFinishedAt',now()) WHERE "messageId"=$1`,[binding.sourceMessageId])
        }
        await client.query(`UPDATE group_task_bindings SET "lastReportedRevision"=$3 WHERE "conversationId"=$1 AND "issueId"=$2`,[conversationId,binding.issueId,task.revision])
        await client.query('COMMIT');count++
      } catch(error) {await client.query('ROLLBACK');throw error}
    }
  } finally {client.release()}
  return count
}
