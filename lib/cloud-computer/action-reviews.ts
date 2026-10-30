import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { ComputerError } from '@/lib/computer/store'
import { SubagentStore, type Actor } from './subagents'
import { lockBrowserAuthority } from './browser-authority'
import { browserEffects, browserMutationSchema, observationMetadata, type BrowserMutation, type VisualObservation } from './visual-contract'
import { maskForWorkspace } from '@/lib/secrets/runtime'
import type { judgeVisualBrowserAction } from './visual-model'
export { browserMutationSchema } from './visual-contract'
export type { BrowserMutation } from './visual-contract'
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const approvedSchema=z.object({
  version:z.literal(2), actionId:z.uuid(),workspaceId:z.uuid(),botId:z.uuid(),subagentId:z.uuid(),epoch:z.number().int(),
  loaderId:z.string(),origin:z.string(),observationId:z.string().regex(/^[a-f0-9]{32}$/),observedAt:z.number().int(),
  mutation:browserMutationSchema,summary:z.string().max(500),effect:z.enum(browserEffects),policyRevision:z.string().regex(/^[a-f0-9]{64}$/),
  judgment:z.object({executionId:z.uuid(),requestDigest:z.string().regex(/^[a-f0-9]{64}$/),imageDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  digest:z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
type Judgment=Awaited<ReturnType<typeof judgeVisualBrowserAction>>
type Query={query:(sql:string,params?:unknown[])=>Promise<unknown>}
/** #438: the executable mutation lives only while the action can still run. Once it is done, declined,
 * failed or expired the row keeps the masked summary and the digest (replay matching) only. */
const SCRUB=`input=(input-'mutation')||'{"mutationScrubbed":true}'::jsonb`
export async function scrubBrowserMutation(q:Query,actionId:string) {
  await q.query(`UPDATE pending_actions SET ${SCRUB} WHERE id=$1 AND action='browser_operation' AND input ? 'mutation' AND status IN ('done','declined','failed')`,[actionId])
}
/** Expire this person's stale undecided browser actions and scrub every terminal one that still holds a mutation. */
export async function sweepBrowserMutations(q:Query,userId:string) {
  await q.query(`UPDATE pending_actions SET status='failed',error='browserActionExpired' WHERE "userId"=$1 AND action='browser_operation' AND status='pending' AND "createdAt"<=now()-interval '5 minutes'`,[userId])
  await q.query(`UPDATE pending_actions SET ${SCRUB} WHERE "userId"=$1 AND action='browser_operation' AND input ? 'mutation' AND status IN ('done','declined','failed')`,[userId])
}

/** Only the workflow holding the real visual-model/Decisions response calls
 * this adapter. Neither HTTP input nor model output provides authorization.
 * The Decisions judgment (within_task) is the only gate before the action;
 * there is no human approval step (Alex, 2026-10-30). Deny still blocks. */
export async function browserAction(pool:Pool,actor:Actor,botId:string,id:string,mutation:BrowserMutation,rawSummary:string,observation:VisualObservation,judgment:Judgment) {
  if (judgment.scope!=='within_task' || judgment.execution.vision!=='image-input-submitted' || judgment.execution.imageDigests[0]!==observationMetadata(observation).imageDigest) throw new ComputerError(409,'Browser judgment unavailable')
  // 4e2 item 4: the summary is persisted (pending_actions, needs, step, subagent_events). The mutation is
  // the executable action and is NOT masked (masking would type the placeholder); see #438 table.
  const summary=await maskForWorkspace(actor.workspaceId,rawSummary)
  await sweepBrowserMutations(pool,actor.userId)
  const client=await pool.connect()
  let input:z.infer<typeof approvedSchema>
  try {
    await client.query('BEGIN')
    const current=await lockBrowserAuthority(client,actor,botId,id,judgment.effect)
    if (current.row.status!=='running' || current.row.activeActionId) throw new ComputerError(409,'Browser task waiting')
    if(current.permission==='deny') throw new ComputerError(403,'Browser action denied')
    const body={version:2 as const,actionId:randomUUID(),workspaceId:actor.workspaceId,botId,subagentId:id,epoch:current.row.epoch,loaderId:observation.loaderId,origin:observation.origin,observationId:observation.observationId,observedAt:observation.observedAt,mutation:browserMutationSchema.parse(mutation),summary:summary.slice(0,500),effect:judgment.effect,policyRevision:current.revision,judgment:{executionId:judgment.execution.executionId,requestDigest:judgment.execution.requestDigest,imageDigest:observationMetadata(observation).imageDigest}}
    input=approvedSchema.parse({...body,digest:hash([actor.userId,body])})
    await client.query(`INSERT INTO pending_actions(id,"userId",action,input,status) VALUES($1,$2,'browser_operation',$3,'running')`,[input.actionId,actor.userId,input])
    await client.query(`WITH changed AS (UPDATE bot_subagents SET status='running',needs=NULL,step='Executing authorized action',"activeActionId"=$2 WHERE id=$1 RETURNING *) INSERT INTO subagent_events("ownerId","workspaceId","botId","subagentId",event) SELECT "ownerId","workspaceId","botId",id,jsonb_build_object('type','data-subagent','data',jsonb_build_object('botId',"botId",'subagentId',id,'task',task,'state',status,'step',step,'needs',needs)) FROM changed`,[id,input.actionId])
    await client.query('COMMIT')
  } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
  const result=await executeApprovedBrowserAction(pool,actor.userId,input,true)
  if ('error' in result) throw new ComputerError(409,result.error)
  return {state:'running' as const,actionId:input.actionId}
}

/** Both an existing user decision and an automatic policy allow consume the
 * SAME stored operation. Recheck live scope/policy and exact payload; gateway
 * receipts prevent a lost response from causing the underlying click twice. */
export async function executeApprovedBrowserAction(pool:Pool,userId:string,raw:unknown,approved:boolean):Promise<{data:Record<string,unknown>}|{error:string}> {
  let input:z.infer<typeof approvedSchema>|undefined
  const client=await pool.connect()
  let invoking=false, bound=false, released=false
  const release=()=>{if(!released){client.release();released=true}}
  try {
    input=approvedSchema.parse(raw)
    const {digest,...body}=input
    if(hash([userId,body])!==digest) throw new Error('browserActionChanged')
    const {authorizeSubscriptionWorkspace}=await import('@/lib/subscription-runtime')
    await authorizeSubscriptionWorkspace(userId,input.workspaceId)
    await client.query('BEGIN')
    const actor={userId,workspaceId:input.workspaceId}
    let action=(await client.query(`SELECT * FROM pending_actions WHERE id=$1 AND "userId"=$2 AND action='browser_operation' AND input->>'digest'=$3 AND "createdAt">now()-interval '5 minutes'`,[input.actionId,userId,digest])).rows[0]
    if(action?.status==='done' && action.result?.accepted===true) {
      await client.query('COMMIT');return {data:{subagentId:input.subagentId,accepted:true,replayed:true}}
    }
    const current=await lockBrowserAuthority(client,actor,input.botId,input.subagentId,input.effect)
    action=(await client.query(`SELECT * FROM pending_actions WHERE id=$1 AND "userId"=$2 AND action='browser_operation' AND input->>'digest'=$3 FOR UPDATE`,[input.actionId,userId,digest])).rows[0]
    if(action?.status==='done' && action.result?.accepted===true) {
      await client.query('COMMIT');return {data:{subagentId:input.subagentId,accepted:true,replayed:true}}
    }
    if(!action || action.status!==(approved?'running':'declined') || current.row.epoch!==input.epoch || (current.row.activeActionId!==input.actionId && (current.row.needs?.kind!=='approval' || current.row.needs.actionId!==input.actionId)) || current.revision!==input.policyRevision || current.permission==='deny') throw new Error('browserActionExpired')
    bound=true
    if(!approved) {
      await client.query(`UPDATE bot_subagents SET status='running',needs=NULL,"activeActionId"=NULL,step='Operation declined; choosing another approach' WHERE id=$1`,[input.subagentId])
      await client.query(`UPDATE pending_actions SET ${SCRUB} WHERE id=$1 AND action='browser_operation'`,[input.actionId])
      await client.query('COMMIT');return {data:{declined:true}}
    }
    const machine=(await client.query(`SELECT "sandboxId" FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2 AND state='running'`,[input.workspaceId,userId])).rows[0]
    if(!machine?.sandboxId) throw new Error('browserUnavailable')
    // Persist invocation before external I/O; do not manufacture an uninvoked
    // state if a response or process is lost. The gateway owns repeat safety.
    // An interrupted invocation is reconciled through the same gateway ID.
    // Its durable receipt returns the old result or unknown, never a second click.
    await client.query(`UPDATE pending_actions SET result=$2 WHERE id=$1`,[input.actionId,{invocationStarted:true}])
    await client.query('COMMIT')
    invoking=true
    await client.query('BEGIN')
    const latest=await lockBrowserAuthority(client,actor,input.botId,input.subagentId,input.effect)
    const completed=(await client.query(`SELECT result FROM pending_actions WHERE id=$1 AND "userId"=$2 AND input->>'digest'=$3 AND status='done' FOR SHARE`,[input.actionId,userId,input.digest])).rows[0]
    if(completed?.result?.accepted===true) {
      await client.query('COMMIT');return {data:{subagentId:input.subagentId,accepted:true,replayed:true}}
    }
    if(latest.revision!==input.policyRevision || latest.permission==='deny' || (latest.row.activeActionId!==input.actionId && (latest.row.needs?.kind!=='approval' || latest.row.needs.actionId!==input.actionId))) throw new Error('browserActionExpired')
    const {runtimeRequest}=await import('./runtime')
    const receipt=await runtimeRequest(machine.sandboxId,latest.row,'/action',{...input.mutation,actionId:input.actionId,expectedObservationId:input.observationId})
    if(receipt.accepted!==true || receipt.actionId!==input.actionId) throw new Error('browserActionOutcomeUnknown')
    await client.query(`UPDATE pending_actions SET status='done',result=$2,error=NULL,${SCRUB} WHERE id=$1 AND status='running'`,[input.actionId,{accepted:true,actionId:input.actionId}])
    await client.query(`UPDATE bot_subagents SET status='running',needs=NULL,"activeActionId"=NULL,step=$2,"consecutiveFailures"=0 WHERE id=$1 AND status IN ('running','needs_you')`,[input.subagentId,input.summary])
    await client.query('COMMIT')
    return {data:{subagentId:input.subagentId,accepted:true}}
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined)
    release()
    const message=error instanceof Error?error.message:''
    const stale=message==='observation_stale' || message==='browserActionExpired'
    if(input && bound) {
      await pool.query(`UPDATE pending_actions SET status='failed',error=$2 WHERE id=$1 AND "userId"=$3 AND status='running'`,[input.actionId,stale?'browserActionExpired':'browserActionOutcomeUnknown',userId])
      await scrubBrowserMutation(pool,input.actionId)
      const store=new SubagentStore(pool),actor={userId,workspaceId:input.workspaceId}
      if(stale) await pool.query(`UPDATE bot_subagents SET "activeActionId"=NULL,status='running',needs=NULL,step='Page or authorization changed; observing again' WHERE id=$1 AND "ownerId"=$2 AND "activeActionId"=$3 AND status IN ('running','needs_you')`,[input.subagentId,userId,input.actionId])
      else if(invoking) {
        const current=await store.get(actor,input.botId,input.subagentId).catch(()=>null)
        if(current?.activeActionId===input.actionId) await store.update(actor,input.botId,input.subagentId,'needs_you','Action outcome unknown; do not repeat blindly').catch(()=>undefined)
      }
    }
    return {error:stale?'browserActionExpired':'browserActionOutcomeUnknown'}
  } finally {release()}
}
