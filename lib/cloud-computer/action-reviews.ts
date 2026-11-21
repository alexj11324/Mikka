import 'server-only'
import { lockSubagentEvents, notifySubagentEvents } from '@/lib/computer/event-log'
import { pendingActionsChanged } from '../live/pending-actions'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { ComputerError } from '@/lib/computer/store'
import { SubagentStore, type Actor } from './subagents'
import { lockBrowserAuthority } from './browser-authority'
import { wakeTokens, wakeWorkflowSoon } from '@/lib/workflow-wake'
import { browserMutationSchema, observationMetadata, type BrowserMutation, type VisualObservation, type BrowserEffect } from './visual-contract'
import { maskFor } from '@/lib/secrets/runtime'
import type { judgeVisualBrowserAction } from './visual-model'
export { browserMutationSchema } from './visual-contract'
export type { BrowserMutation } from './visual-contract'
type Judgment=Awaited<ReturnType<typeof judgeVisualBrowserAction>>
type Query={query:(sql:string,params?:unknown[])=>Promise<unknown>}
/** #438: the executable mutation lives only while the action can still run. Once it is done, declined,
 * failed or expired the row keeps the masked summary and the digest (replay matching) only. Legacy
 * rows written before the approval pipeline was removed are still scrubbed here; nothing writes new
 * browser_operation rows any more. */
const SCRUB=`input=(input-'mutation')||'{"mutationScrubbed":true}'::jsonb`
export async function scrubBrowserMutation(q:Query,actionId:string) {
  await q.query(`UPDATE pending_actions SET ${SCRUB} WHERE id=$1 AND action='browser_operation' AND input ? 'mutation' AND status IN ('done','declined','failed')`,[actionId])
}
/** Expire this person's stale undecided browser actions and scrub every terminal one that still holds a mutation. */
export async function sweepBrowserMutations(q:Query,userId:string) {
  const expired = await q.query(`UPDATE pending_actions SET status='failed',error='browserActionExpired' WHERE "userId"=$1 AND action='browser_operation' AND status='pending' AND "createdAt"<=now()-interval '5 minutes' RETURNING id`,[userId]) as { rows: { id: string }[] }
  for (const row of expired.rows) await pendingActionsChanged(q, row.id, userId)
  await q.query(`UPDATE pending_actions SET ${SCRUB} WHERE "userId"=$1 AND action='browser_operation' AND input ? 'mutation' AND status IN ('done','declined','failed')`,[userId])
}

/** The operation a workflow judged within_task, bound to the subagent row's
 * activeActionId. The row is the durable replay handle: a retry after a lost
 * response replays the same actionId and the gateway receipt dedupes it —
 * never a second click. There is no pending_actions record, digest or policy
 * revision; deny is re-read from the workspace policy at execution. */
export type BrowserActionInput = {
  actionId: string, workspaceId: string, botId: string, subagentId: string, epoch: number,
  loaderId: string, origin: string, observationId: string, effect: BrowserEffect,
  mutation: BrowserMutation, summary: string,
}

/** Only the workflow holding the real visual-model/Decisions response calls
 * this adapter. Neither HTTP input nor model output provides authorization.
 * The Decisions judgment (within_task) is the only gate before the action;
 * there is no human approval step (Alex, 2026-10-30). Deny still blocks. */
export async function browserAction(pool:Pool,actor:Actor,botId:string,id:string,mutation:BrowserMutation,rawSummary:string,observation:VisualObservation,judgment:Judgment) {
  if (judgment.scope!=='within_task' || judgment.execution.vision!=='image-input-submitted' || judgment.execution.imageDigests[0]!==observationMetadata(observation).imageDigest) throw new ComputerError(409,'Browser judgment unavailable')
  const summary=await maskFor({ workspaceId: actor.workspaceId, ownerId: actor.userId },rawSummary)
  await sweepBrowserMutations(pool,actor.userId)
  const input:BrowserActionInput={actionId:randomUUID(),workspaceId:actor.workspaceId,botId,subagentId:id,epoch:0,loaderId:observation.loaderId,origin:observation.origin,observationId:observation.observationId,effect:judgment.effect,mutation:browserMutationSchema.parse(mutation),summary:summary.slice(0,500)}
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    const current=await lockBrowserAuthority(client,actor,botId,id,judgment.effect)
    if (current.row.status!=='running' || current.row.activeActionId) throw new ComputerError(409,'Browser task waiting')
    if(current.permission==='deny') throw new ComputerError(403,'Browser action denied')
    input.epoch=current.row.epoch
    await lockSubagentEvents(client, { ownerId: actor.userId, workspaceId: actor.workspaceId })
    await client.query(`WITH changed AS (UPDATE bot_subagents SET status='running',needs=NULL,step='Executing authorized action',"activeActionId"=$2 WHERE id=$1 RETURNING *) INSERT INTO subagent_events("ownerId","workspaceId","botId","subagentId",event) SELECT "ownerId","workspaceId","botId",id,jsonb_build_object('type','data-subagent','data',jsonb_build_object('botId',"botId",'subagentId',id,'task',task,'state',status,'step',step,'needs',needs)) FROM changed`,[id,input.actionId])
    await client.query('COMMIT')
    notifySubagentEvents({ ownerId: actor.userId, workspaceId: actor.workspaceId })
  } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
  const result=await executeBrowserAction(pool,actor,input)
  if ('error' in result) throw new ComputerError(409,result.error)
  return {state:'running' as const,actionId:input.actionId}
}

/** Executes the stored operation. Live scope/policy is re-read under the same
 * locks the writers take, the epoch and the bound action id must still match,
 * and the sandbox gateway's durable receipt makes a replayed actionId return
 * the old result instead of executing again. */
export async function executeBrowserAction(pool:Pool,actor:Actor,input:BrowserActionInput):Promise<{data:Record<string,unknown>}|{error:string}> {
  try { return await execute(pool,actor,input) }
  finally { wakeWorkflowSoon(wakeTokens.subagent(input.subagentId)) }
}
async function execute(pool:Pool,actor:Actor,input:BrowserActionInput):Promise<{data:Record<string,unknown>}|{error:string}> {
  let bound=false, invoking=false
  try {
    const {authorizeSubscriptionWorkspace}=await import('@/lib/subscription-runtime')
    await authorizeSubscriptionWorkspace(actor.userId,input.workspaceId)
    const client=await pool.connect()
    try {
      await client.query('BEGIN')
      const current=await lockBrowserAuthority(client,actor,input.botId,input.subagentId,input.effect)
      if(current.row.epoch!==input.epoch || current.row.activeActionId!==input.actionId || current.permission==='deny') throw new Error('browserActionExpired')
      const machine=(await client.query(`SELECT "sandboxId" FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2 AND state='running'`,[input.workspaceId,actor.userId])).rows[0]
      if(!machine?.sandboxId) throw new Error('browserUnavailable')
      bound=true
      await client.query('COMMIT')
      invoking=true
      await client.query('BEGIN')
      const latest=await lockBrowserAuthority(client,actor,input.botId,input.subagentId,input.effect)
      if(latest.row.epoch!==input.epoch || latest.row.activeActionId!==input.actionId || latest.permission==='deny') throw new Error('browserActionExpired')
      const {runtimeRequest}=await import('./runtime')
      const receipt=await runtimeRequest(machine.sandboxId,latest.row,'/action',{...input.mutation,actionId:input.actionId,expectedObservationId:input.observationId})
      if(receipt.accepted!==true || receipt.actionId!==input.actionId) throw new Error('browserActionOutcomeUnknown')
      await client.query(`UPDATE bot_subagents SET status='running',needs=NULL,"activeActionId"=NULL,step=$2,"consecutiveFailures"=0 WHERE id=$1 AND status IN ('running','needs_you')`,[input.subagentId,input.summary])
      await client.query('COMMIT')
      return {data:{subagentId:input.subagentId,accepted:true}}
    } catch(error) {await client.query('ROLLBACK').catch(()=>undefined);throw error} finally {client.release()}
  } catch(error) {
    const message=error instanceof Error?error.message:''
    const stale=message==='observation_stale' || message==='browserActionExpired'
    if(bound) {
      const store=new SubagentStore(pool)
      if(stale) await pool.query(`UPDATE bot_subagents SET "activeActionId"=NULL,status='running',needs=NULL,step='Page or authorization changed; observing again' WHERE id=$1 AND "ownerId"=$2 AND "activeActionId"=$3 AND status IN ('running','needs_you')`,[input.subagentId,actor.userId,input.actionId])
      else if(invoking) {
        const current=await store.get(actor,input.botId,input.subagentId).catch(()=>null)
        if(current?.activeActionId===input.actionId) await store.update(actor,input.botId,input.subagentId,'needs_you','Action outcome unknown; do not repeat blindly').catch(()=>undefined)
      }
    }
    return {error:stale?'browserActionExpired':'browserActionOutcomeUnknown'}
  }
}
