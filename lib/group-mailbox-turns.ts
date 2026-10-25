import type {PoolClient} from 'pg'
import type {Directory} from './group-conversations-store'
import {correctionFrom, mentionRoute, type GroupRoute} from './coordinator/group-routing'
import {enqueueWork,requireAgent,reject,ReviewFailure,cancelWork} from './group-review-access'

/** Adapted PR166 policy: only creates existing durable work, never calls a provider.
 * Explicit mentions win. Without an approved decision provider, an explicit Lead
 * is the safe fallback; no Agent is selected by private configuration or join order. */
export async function enqueueMailboxTurn(client:PoolClient,directory:Directory,group:Record<string,string>,userId:string,messageId:string,text:string,mentions:string[]) {
 const selected=mentions.length?mentions:group.leadAgentId?[group.leadAgentId]:[]
 const route:GroupRoute=mentionRoute({text,mentions},selected.map(id=>({id,name:'',description:''})))??{by:'lead',responders:selected as [string]}
 if(!selected.length)return
 for(const id of selected){
  try{await requireAgent(client,directory,group.id,group.workspaceId,id)}catch(error){
   if(mentions.length || !(error instanceof ReviewFailure))throw error
   await client.query('UPDATE conversations SET "leadAgentId"=NULL WHERE id=$1',[group.id]);return
  }
 }
 const previous=(await client.query(`SELECT m.body,t.route FROM group_mailbox_turns t JOIN conversation_messages m ON m.id=t."messageId" WHERE t."conversationId"=$1 ORDER BY m.position DESC LIMIT 1`,[group.id])).rows[0]
 if(previous&&previous.route.responders.length===1){
  const c=correctionFrom({message:previous.body,responderId:previous.route.responders[0],by:previous.route.by},{text,mentions})
  if(c)await client.query(`INSERT INTO group_mailbox_corrections("messageId","conversationId",message,"wrongId","rightId") VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[messageId,group.id,c.message,c.wrongId,c.rightId??null])
 }
 await client.query('INSERT INTO group_mailbox_turns("messageId","conversationId",route) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[messageId,group.id,JSON.stringify(route)])
 for(const [ordinal,id] of [...new Set(selected)].entries())await enqueueWork(client,directory,group.id,userId,messageId,id,0,ordinal)
}
/** Shared SQL filter is evaluated BEFORE poll LIMIT and rechecked under the
 * conversation lock. One blocked group must never starve unrelated groups. */
export const TURN_READY_SQL=`(NOT EXISTS(SELECT 1 FROM group_mailbox_turns t WHERE t."messageId"=w."triggerMessageId") OR NOT EXISTS(
 SELECT 1 FROM conversation_work earlier JOIN group_mailbox_turns t ON t."messageId"=earlier."triggerMessageId"
 JOIN conversation_messages a ON a.id=earlier."triggerMessageId" JOIN conversation_messages b ON b.id=w."triggerMessageId"
 WHERE earlier."conversationId"=w."conversationId" AND earlier.id<>w.id AND earlier.status IN ('pending','dispatched') AND NOT EXISTS(SELECT 1 FROM agent_runs stopped WHERE stopped.id=earlier."runId" AND stopped."stopRequestedAt" IS NOT NULL)
 AND (a.position,earlier.round,earlier.ordinal,earlier.id)<(b.position,w.round,w.ordinal,w.id)))`
export async function turnReady(client:PoolClient,work:{id:string;conversationId:string}) {
 const stopped=(await client.query(`SELECT w.id FROM conversation_work w JOIN agent_runs r ON r.id=w."runId" WHERE w."conversationId"=$1 AND w.status='dispatched' AND r."stopRequestedAt" IS NOT NULL`,[work.conversationId])).rows
 for(const row of stopped)await cancelWork(client,work.conversationId,{workId:row.id})
 return Boolean((await client.query(`SELECT 1 FROM conversation_work w WHERE w.id=$1 AND ${TURN_READY_SQL}`,[work.id])).rowCount)
}
export async function enqueueFollowups(client:PoolClient,directory:Directory,work:Record<string,any>,mentions:string[]) {
 if(!mentions.length)return
 if(!(await client.query('SELECT 1 FROM group_mailbox_turns WHERE "messageId"=$1 AND "conversationId"=$2',[work.triggerMessageId,work.conversationId])).rowCount)return reject(422,'artifact_followup_forbidden')
 if(work.round>=2)return
 const group=(await client.query('SELECT "workspaceId" FROM conversations WHERE id=$1',[work.conversationId])).rows[0]
 // Agent output nominates only; current grants and original human epoch still gate every hop.
 for(const id of new Set(mentions))await requireAgent(client,directory,work.conversationId,group.workspaceId,id)
 const start=Number((await client.query('SELECT coalesce(max(ordinal),-1)+1 AS next FROM conversation_work WHERE "triggerMessageId"=$1 AND round=$2',[work.triggerMessageId,work.round+1])).rows[0].next)
 for(const [index,id] of [...new Set(mentions)].entries()){
  const next=await enqueueWork(client,directory,work.conversationId,work.requestedBy,work.triggerMessageId,id,work.round+1,start+index)
  if(new Date(next.requesterJoinedAt).getTime()!==new Date(work.requesterJoinedAt).getTime())return reject(403,'membership_changed')
 }
}
