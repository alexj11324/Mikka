import 'server-only'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import { ACTION_ERROR_CODES,type ActionErrorCode } from '@/lib/action-result'
import type { IssueReader } from '@/lib/issue-visibility'
import { authorizedThread,readAuthorizedRunChain } from '@/lib/resource-access/thread'
import { withResourceAccess,requireResourceAccess } from '@/lib/resource-access/store'
import { reserveCollaborativeTurn,releaseUnadmittedCollaborationTurn } from '@/lib/collaboration-run-authority'
import { factoryEventId } from '@/lib/factory/event-id'
import { runChanged } from '@/lib/live/panels'
import { splitChatFiles } from '@mikka/protocol/chat-attachments'

const inputSchema=z.object({runId:z.uuid(),text:z.string().trim().min(1).max(10_000),requestId:z.uuid(),
  executionGrantId:z.uuid().optional(),sessionId:z.string().min(1).optional()}).strict()

/** A human comment is conversation content only. It is already delivered for
 * display and can never be picked up as the owner's native mailbox message. */
async function postComment(reader:IssueReader,runId:string,text:string,requestId:string) {
  const access=await authorizedThread(reader,runId,'canComment')
  const id=factoryEventId('thread-member-comment',`${access.viewerId}:${requestId}`)
  return withResourceAccess(reader,access.reference,'canComment',async(policy,tx)=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'thread-member-comment:'+id},0))`)
    const {rows:[prior]}=await tx.execute<{runId:string;userId:string;text:string}>(sql`
      select "runId","userId",text from run_messages where id=${id}::uuid`)
    if(prior){
      if(prior.runId!==runId||prior.userId!==access.viewerId||prior.text!==text)throw new ActionFailureError('validationGeneric')
      return {runId,continued:false}
    }
    await tx.execute(sql`insert into run_messages(id,"runId","userId",text,origin,"mailboxWakeDepth","deliveredAt")
      values(${id}::uuid,${runId}::uuid,${access.viewerId},${text},'owner',-1,clock_timestamp())`)
    await tx.execute(sql`insert into resource_access_events("resourceKind","resourceId","workspaceId","actorId","ownerId",revision,source,action,detail)
      values('thread',${runId}::uuid,${access.workspaceId}::uuid,${access.viewerId},${access.ownerId},${policy.revision},'thread_comment','commented',
        jsonb_build_object('messageId',${id}::text))`)
    await runChanged(tx,runId)
    return {runId,continued:false}
  })
}

/** Caller identity comes only from the verified request. An execution grant
 * chooses one frozen API connection and a bounded isolated cloud turn; neither
 * a comment nor canSteer can select another person's subscription or device. */
export async function sendCollaborativeThreadMessage(reader:IssueReader,input:z.input<typeof inputSchema>) {
  const value=inputSchema.parse(input)
  const access=await authorizedThread(reader,value.runId,value.executionGrantId?'canSteer':'canComment')
  await requireResourceAccess(reader,access.reference,'canComment')
  if(access.ownerId===access.viewerId)throw new ActionFailureError('validationGeneric')
  if(splitChatFiles(value.text).files.length){
    const {validateChatFiles}=await import('@/lib/chat-attachments/store')
    try{await validateChatFiles(access.viewerId,{kind:'thread',id:value.runId},value.text)}catch(error){throw Object.assign(new ActionFailureError('messageRequired'), {cause:error})}
  }
  if(!value.executionGrantId)return postComment(reader,value.runId,value.text,value.requestId)
  if(!value.sessionId)throw new ActionFailureError('authRequired')
  // A lost response may already have advanced the task to its admitted run.
  // Resolve that exact immutable request before testing the current run head.
  // The delivered dispatch event binds its text, actor and source; a reused
  // UUID cannot edit an earlier request or spend another execution budget.
  const eventId=factoryEventId('thread-member-execution',`${access.viewerId}:${value.requestId}`)
  const {rows:[accepted]}=await pool.query<{runId:string;matches:boolean}>(`SELECT a."runId",
      a."grantId"=$3 AND a."ownerId"=$4 AND a."workspaceId"=$5
      AND mikka_thread_execution_source_allowed($6,a."sourceRunId",a."workspaceId",a."ownerId")
      AND e.payload->>'authorizationId'=a.id::text AND e.payload->>'actorId'=$1 AND e.payload->>'text'=$8 AS matches
    FROM thread_execution_authorizations a LEFT JOIN coordinator_events e ON e.id=$7
    WHERE a."actorId"=$1 AND a."requestId"=$2 AND a."runId" IS NOT NULL`,
  [access.viewerId,value.requestId,value.executionGrantId,access.ownerId,access.workspaceId,value.runId,eventId,value.text])
  if(accepted){
    if(!accepted.matches)throw new ActionFailureError('validationGeneric')
    await postComment(reader,accepted.runId,value.text,value.requestId)
    return {runId:accepted.runId,continued:true}
  }
  const chain=await readAuthorizedRunChain(reader,value.runId)
  if(!chain||!access.issueId)throw new ActionFailureError('threadCannotContinue')
  const sourceRunId=chain.latestRunId
  const {latestTaskRun,dispatchToTask}=await import('@/lib/thread-dispatch')
  const previous=await latestTaskRun(pool,access.ownerId,access.issueId)
  if(previous?.id!==sourceRunId)throw new ActionFailureError('threadReplaced')
  if(!previous.cloud)throw new ActionFailureError('threadExecutionAuthorizationRequired')
  const {UNFINISHED_RUN_STATUSES}=await import('@/lib/agent-run-statuses')
  if(UNFINISHED_RUN_STATUSES.some(status=>status===previous.status))throw new ActionFailureError('threadExecutionBusy')
  const reservation=await reserveCollaborativeTurn(reader,{grantId:value.executionGrantId,threadId:value.runId,sourceRunId,requestId:value.requestId,sessionId:value.sessionId,text:value.text})
  const {rows:[admitted]}=await pool.query<{runId:string}>(`SELECT "runId" FROM thread_execution_authorizations
    WHERE id=$1 AND "runId" IS NOT NULL`,[reservation.authorizationId])
  if(admitted){await postComment(reader,admitted.runId,value.text,value.requestId);return {runId:admitted.runId,continued:true}}
  try{
    const result=await dispatchToTask(access.ownerId,access.issueId,{
      note:value.text,expectedRunId:sourceRunId,requireIdle:true,
      start:async(source,note)=>{
        if(!source?.cloud||source.id!==sourceRunId)throw new ActionFailureError('threadReplaced')
        await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt")
          VALUES($1,$2,$3,$4,'user_message',$5,$6,'background',clock_timestamp()) ON CONFLICT DO NOTHING`,
        [eventId,access.ownerId,source.botId,access.issueId,`thread-collaboration:${eventId}`,JSON.stringify({text:value.text,actorId:access.viewerId,
          source:'thread_collaboration',previousRunId:sourceRunId,postedToChat:true,authorizationId:reservation.authorizationId})])
        const {dispatchComputerTask}=await import('@/workflows/coordinator/steps')
        return dispatchComputerTask(access.ownerId,{botId:source.cloud.botId,issueId:access.issueId!,harness:reservation.harness,
          model:reservation.model,apiKeyId:reservation.credentialId,threadRunId:sourceRunId,note,
          sourceEventId:eventId,factoryBotId:source.botId,withoutBot:source.botId===null,
          ...(source.remoteUrl?{repo:source.remoteUrl}:{}),...(source.readOnly?{readOnly:true}:{})},
        `collaboration:${reservation.authorizationId}`,undefined,undefined,undefined,
        {actorId:access.viewerId,threadOwnerId:access.ownerId,collaborationAuthorizationId:reservation.authorizationId})
      },
    })
    if('error'in result)throw new ActionFailureError((ACTION_ERROR_CODES as readonly string[]).includes(result.error)?result.error as ActionErrorCode:'threadCannotContinue')
    if(result.thread==='message')throw new ActionFailureError('threadExecutionBusy')
    await postComment(reader,result.runId,value.text,value.requestId)
    return {runId:result.runId,continued:true}
  }catch(error){
    await releaseUnadmittedCollaborationTurn(pool,reservation.authorizationId)
    throw error
  }
}

