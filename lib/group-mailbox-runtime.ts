import type { Pool } from 'pg'
import { SessionMailbox } from './session-mailbox'
import type { Directory } from './group-conversations-store'
import { authorizedWork, completeReviewWork, dispatchReviewWork, lockedWork, runMessagesAdapter } from './group-review-runtime'
import { cancelWork, reject, requireGroup, ReviewFailure, transaction } from './group-review-access'

/** Uses the reviewed mailbox storage, with real workspace identity derived
 * from the authorized group. Never the singleton private WORKSPACE_ID. */
export function groupMailboxAdapter(pool: Pool) {
  const adapter = runMessagesAdapter(async (client,input) => {
    const group = (await client.query('SELECT "workspaceId" FROM conversations WHERE id=$1', [input.conversationId])).rows[0]
    const agent = (await client.query(`SELECT a."deviceId",a.harness FROM agents a JOIN devices d ON d.id=a."deviceId" WHERE a.id=$1 AND a."userId"=$2 AND d."ownerId"=$2 AND d.enabled`, [input.agentId,input.ownerId])).rows[0]
    if (!agent) return reject(409,'group_device_unavailable')
    await new SessionMailbox(pool,group.workspaceId).prepareGroup(client,{...input,deviceId:agent.deviceId,harness:agent.harness})
  })
  return { ...adapter,
    async live(client: Parameters<typeof adapter.live>[0], runId:string, agentId:string) {
      if (!await adapter.live(client,runId,agentId)) return false
      return Boolean((await client.query(`SELECT 1 FROM agent_runs r JOIN session_mailboxes m ON m.id=r."mailboxId" JOIN devices d ON d.id=r."deviceId" WHERE d.enabled AND d."ownerId"=r."userId" AND r.id=$1 AND r.status='running' AND r."leaseExpiresAt">now() AND m.kind='group' AND NOT m.disabled AND r."sessionId" IS NULL AND r."worktreePath" IS NULL AND r."resumeSessionId" IS NULL`,[runId])).rowCount)
    },
    async finish(client: Parameters<typeof adapter.live>[0], input: {runId:string;conversationId:string;status:string}) {
      const group=(await client.query('SELECT "workspaceId" FROM conversations WHERE id=$1',[input.conversationId])).rows[0]
      await new SessionMailbox(pool,group.workspaceId).completeGroup(client,input.runId,input.status==='completed'?'succeeded':'stopped')
    },
  }
}
/** Owner/device comes only from authenticated route identity. A bounded poll
 * recovers pending intents; dispatch remains idempotent across polling workers. */
export async function pollGroupReviews(pool:Pool,directory:Directory,userId:string,deviceId:string) {
  const device=(await pool.query('SELECT 1 FROM devices WHERE id=$1 AND "ownerId"=$2 AND enabled',[deviceId,userId])).rowCount
  if (!device) return reject(404,'not_found')
  const pending=(await pool.query(`SELECT w.id FROM conversation_work w JOIN agents a ON a.id=w."agentId" WHERE a."userId"=$1 AND a."deviceId"=$2 AND w.status='pending' ORDER BY w."createdAt",w.id LIMIT 20`,[userId,deviceId])).rows
  for (const work of pending) {
    try { await dispatchReviewWork(pool,directory,groupMailboxAdapter(pool),work.id) }
    catch(error) { if (!(error instanceof ReviewFailure) || error.code!=='group_device_unavailable') throw error }
  }
  return {runIds:(await pool.query(`SELECT r.id FROM agent_runs r JOIN conversation_work w ON w."runId"=r.id JOIN session_mailboxes m ON m.id=r."mailboxId" WHERE r."userId"=$1 AND r."deviceId"=$2 AND r.kind='group_review' AND w.status='dispatched' AND r."stopRequestedAt" IS NULL AND NOT m.disabled AND (r.status='queued' OR (r.status='running' AND r."leaseExpiresAt"<now())) ORDER BY w."createdAt" LIMIT 20`,[userId,deviceId])).rows.map(row=>row.id as string)}
}
export async function claimGroupReview(pool:Pool,directory:Directory,userId:string,deviceId:string,runId:string) {
  return transaction(pool,async client=>{
    const identity=(await client.query('SELECT id FROM conversation_work WHERE "runId"=$1',[runId])).rows[0]
    if (!identity) return reject(404,'not_found')
    const work=await lockedWork(client,identity.id)
    const run=(await client.query(`SELECT r.*,d.enabled FROM agent_runs r JOIN devices d ON d.id=r."deviceId" WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3 AND d."ownerId"=$2 FOR UPDATE OF r`,[runId,userId,deviceId])).rows[0]
    if (!run || run.kind!=='group_review') return reject(404,'not_found')
    if (work.status!=='dispatched' || !run.enabled || run.stopRequestedAt) return reject(409,'work_not_live')
    try { await authorizedWork(client,directory,work) }
    catch(error) { if (!(error instanceof ReviewFailure)) throw error; await cancelWork(client,work.conversationId,{workId:work.id});return {status:'cancelled' as const} }
    if (run.status!=='queued' && !(run.status==='running' && run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime()<Date.now())) return reject(409,'already_claimed')
    const {group}=await requireGroup(client,directory,work.conversationId,work.requestedBy)
    const messages=await new SessionMailbox(pool,group.workspaceId).groupInbox(client,runId,userId)
    if (messages.length!==1 || messages[0].id!==work.id) return reject(409,'isolated_input_required')
    const epoch=(await client.query('UPDATE conversation_work SET "claimEpoch"="claimEpoch"+1 WHERE id=$1 RETURNING "claimEpoch"',[work.id])).rows[0].claimEpoch as number
    await client.query(`UPDATE agent_runs SET status='running',"startedAt"=coalesce("startedAt",now()),"leaseExpiresAt"=now()+interval '90 seconds',"updatedAt"=now() WHERE id=$1`,[runId])
    return {status:'claimed' as const,runId,claimEpoch:epoch,envelope:JSON.parse(messages[0].text) as unknown,capabilities:{tools:[] as string[],history:[] as string[],repository:null,credentials:null}}
  })
}
export async function finishGroupReview(pool:Pool,directory:Directory,userId:string,deviceId:string,runId:string,input:unknown) {
  const owned=(await pool.query(`SELECT 1 FROM agent_runs r JOIN devices d ON d.id=r."deviceId" WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3 AND d."ownerId"=$2 AND r.kind='group_review'`,[runId,userId,deviceId])).rowCount
  if (!owned) return reject(404,'not_found')
  return completeReviewWork(pool,directory,groupMailboxAdapter(pool),runId,input)
}

/** Read-side lease check also propagates cross-database suspension into the
 * group-local stop fence. No input or private run state is disclosed. */
export async function checkGroupReview(pool:Pool,directory:Directory,userId:string,deviceId:string,runId:string,claimEpoch:number) {
  return transaction(pool,async client=>{
    const identity=(await client.query('SELECT id FROM conversation_work WHERE "runId"=$1',[runId])).rows[0]
    if (!identity) return reject(404,'not_found')
    const work=await lockedWork(client,identity.id)
    const run=(await client.query(`SELECT r.status,r."stopRequestedAt",r."leaseExpiresAt",d.enabled FROM agent_runs r JOIN devices d ON d.id=r."deviceId" WHERE r.id=$1 AND r."userId"=$2 AND r."deviceId"=$3 AND d."ownerId"=$2 AND r.kind='group_review' FOR UPDATE OF r`,[runId,userId,deviceId])).rows[0]
    if (!run) return reject(404,'not_found')
    if (work.status!=='dispatched' || work.claimEpoch!==claimEpoch || run.stopRequestedAt || run.status!=='running' || !run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime()<=Date.now()) return {live:false}
    try { await authorizedWork(client,directory,work);if (!run.enabled) return reject(409,'device_disabled') }
    catch(error){if(!(error instanceof ReviewFailure))throw error;await cancelWork(client,work.conversationId,{workId:work.id});return{live:false}}
    return {live:true}
  })
}
