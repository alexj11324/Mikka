import {turnReady,TURN_READY_SQL} from './group-mailbox-turns'
import { lockedGroupRun } from './group-worker-authority'
import type { Pool, PoolClient } from 'pg'
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
      const run = await lockedGroupRun(client,runId)
      return run.enabled && run.status==='running' && run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime()>Date.now()
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
  const pending=(await pool.query(`SELECT w.id FROM conversation_work w JOIN agents a ON a.id=w."agentId" WHERE a."userId"=$1 AND a."deviceId"=$2 AND w.status='pending' AND ${TURN_READY_SQL} ORDER BY w."createdAt",w.id LIMIT 20`,[userId,deviceId])).rows
  for (const work of pending) {
    try { await dispatchReviewWork(pool,directory,groupMailboxAdapter(pool),work.id) }
    catch(error) { if (!(error instanceof ReviewFailure) || error.code!=='group_device_unavailable') throw error }
  }
  return {runIds:(await pool.query(`SELECT r.id FROM agent_runs r JOIN conversation_work w ON w."runId"=r.id JOIN session_mailboxes m ON m.id=r."mailboxId" WHERE r."userId"=$1 AND r."deviceId"=$2 AND r.kind='group_review' AND w.status='dispatched' AND w."uncertainAt" IS NULL AND r."stopRequestedAt" IS NULL AND NOT m.disabled AND (r.status='queued' OR (r.status='running' AND r."leaseExpiresAt"<now())) ORDER BY w."createdAt" LIMIT 20`,[userId,deviceId])).rows.map(row=>row.id as string)}
}
export async function claimGroupReview(pool:Pool,directory:Directory,userId:string,deviceId:string,runId:string,onClaim?:(client:PoolClient)=>Promise<void>) {
  return transaction(pool,async client=>{
    const identity=(await client.query('SELECT id FROM conversation_work WHERE "runId"=$1',[runId])).rows[0]
    if (!identity) return reject(404,'not_found')
    const work=await lockedWork(client,identity.id)
    const run=await lockedGroupRun(client,runId)
    if(run.userId!==userId || run.deviceId!==deviceId) return reject(404,'not_found')
    if (!run || run.kind!=='group_review') return reject(404,'not_found')
    if (work.status!=='dispatched' || !run.enabled || run.stopRequestedAt) return reject(409,'work_not_live')
    try { await authorizedWork(client,directory,work) }
    catch(error) { if (!(error instanceof ReviewFailure)) throw error; await cancelWork(client,work.conversationId,{workId:work.id});return {status:'cancelled' as const} }
    if(work.uncertainAt || (run.status==='queued'&&work.claimEpoch>0) || (run.status==='running' && run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime()<Date.now())) {
      await client.query('UPDATE conversation_work SET "uncertainAt"=coalesce("uncertainAt",now()) WHERE id=$1',[work.id])
      return {status:'uncertain' as const}
    }
    if(run.status!=='queued')return reject(409,'already_claimed')
    if(!await turnReady(client,work))return reject(409,'waiting_turn')
    const {group}=await requireGroup(client,directory,work.conversationId,work.requestedBy)
    const messages=await new SessionMailbox(pool,group.workspaceId).groupInbox(client,runId,userId)
    if (messages.length!==1 || messages[0].id!==work.id) return reject(409,'isolated_input_required')
    const epoch=(await client.query('UPDATE conversation_work SET "claimEpoch"="claimEpoch"+1 WHERE id=$1 RETURNING "claimEpoch"',[work.id])).rows[0].claimEpoch as number
    await client.query(`UPDATE agent_runs SET status='running',"startedAt"=coalesce("startedAt",now()),"leaseExpiresAt"=now()+interval '90 seconds',"updatedAt"=now() WHERE id=$1`,[runId])
    await onClaim?.(client)
    if (!['claude_code','codex'].includes(run.harness)) return reject(409,'unsupported_group_harness')
    return {status:'claimed' as const,runId,harness:run.harness as 'claude_code'|'codex',claimEpoch:epoch,envelope:JSON.parse(messages[0].text) as unknown,capabilities:{tools:[] as string[],history:[] as string[],repository:null,credentials:null}}
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
    const run=await lockedGroupRun(client,runId)
    if(run.userId!==userId || run.deviceId!==deviceId) return reject(404,'not_found')
    if (!run) return reject(404,'not_found')
    if (work.status!=='dispatched' || work.claimEpoch!==claimEpoch || run.stopRequestedAt || run.status!=='running' || !run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime()<=Date.now()) return {live:false}
    try { await authorizedWork(client,directory,work);if (!run.enabled) return reject(409,'device_disabled') }
    catch(error){if(!(error instanceof ReviewFailure))throw error;await cancelWork(client,work.conversationId,{workId:work.id});return{live:false}}
    return {live:true}
  })
}

/** Runtime failure is a terminal fence, never an authored reply or approval.
 * Only the current authenticated claim may close its still-live work. */
export async function failGroupReview(pool:Pool,directory:Directory,userId:string,deviceId:string,runId:string,claimEpoch:number) {
  return transaction(pool,async client=>{
    const identity=(await client.query('SELECT id FROM conversation_work WHERE "runId"=$1',[runId])).rows[0]
    if(!identity)return reject(404,'not_found')
    const work=await lockedWork(client,identity.id)
    const run=await lockedGroupRun(client,runId)
    if(run.userId!==userId || run.deviceId!==deviceId) return reject(404,'not_found')
    if(!run||!run.enabled)return reject(404,'not_found')
    if(work.status!=='dispatched')return{status:work.status}
    if(run.stopRequestedAt){await cancelWork(client,work.conversationId,{workId:work.id});return{status:'cancelled'}}
    if(work.claimEpoch!==claimEpoch||run.status!=='running'||!run.leaseExpiresAt||new Date(run.leaseExpiresAt).getTime()<=Date.now())return reject(409,'claim_epoch_mismatch')
    try{await authorizedWork(client,directory,work)}catch(error){if(!(error instanceof ReviewFailure))throw error;await cancelWork(client,work.conversationId,{workId:work.id});return{status:'cancelled'}}
    await cancelWork(client,work.conversationId,{workId:work.id})
    await client.query('UPDATE agent_runs SET error=$2 WHERE id=$1',[runId,'group_processor_failed'])
    return{status:'cancelled',runtimeError:'group_processor_failed'}
  })
}
