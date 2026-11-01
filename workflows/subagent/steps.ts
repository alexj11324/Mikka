import type { Actor } from '@/lib/cloud-computer/subagents'
import { browserLoginContinuation } from '@/lib/cloud-computer/login-result'
export type WebTick = 'terminal'|'waiting'|'running'|'retry'

export async function tick(actor:Actor,botId:string,id:string):Promise<WebTick> {
  'use step'
  const {pool}=await import('@/lib/db')
  const {SubagentStore}=await import('@/lib/cloud-computer/subagents')
  const store=new SubagentStore(pool)
  let row=await store.get(actor,botId,id)
  if(['done','failed','stopped'].includes(row.status)) {
    await store.cleanup(actor,botId,id)
    await report(actor,botId,id,`Web task ${row.task}: ${row.status}. ${row.step}`,row.status)
    return 'terminal'
  }
  if(row.nextAttemptAt && new Date(row.nextAttemptAt).getTime()>Date.now()) return 'retry'
  try {
    row=await store.start(actor,botId,id)
    if(row.status==='queued') return 'waiting'
    if(row.activeActionId) {
      const previous=(await pool.query(`SELECT input,status,action,result FROM pending_actions WHERE id=$1 AND "userId"=$2 AND action IN ('browser_operation','credential_operation')`,[row.activeActionId,actor.userId])).rows[0]
      if(previous?.action==='credential_operation' && previous.status==='running') {
        // A credential broker may already have filled/submitted. Do not start a
        // fresh login operation after a process loss with an unknown outcome.
        if(previous.result?.invocationStarted) {
          await store.update(actor,botId,id,'needs_you','Login outcome unknown; secure page retained',{kind:'login',site:String(previous.input?.origin ?? '')})
          return 'waiting'
        }
        const {executeCredentialOperation}=await import('@/lib/cloud-computer/credential-reviews')
        const outcome=await executeCredentialOperation(pool,actor.userId,previous.input,true)
        return 'error' in outcome?'waiting':'running'
      }
      if(previous?.action==='browser_operation' && previous.status==='running') {
        const {executeApprovedBrowserAction}=await import('@/lib/cloud-computer/action-reviews')
        const result=await executeApprovedBrowserAction(pool,actor.userId,previous.input,true)
        return 'error' in result && result.error!=='browserActionExpired'?'waiting':'running'
      }
      if(previous?.status==='pending') {
        const expired=await pool.query(`UPDATE pending_actions SET status='failed',error='browserActionExpired' WHERE id=$1 AND status='pending' AND "createdAt"<now()-interval '5 minutes' RETURNING id`,[row.activeActionId])
        if(!expired.rowCount) return 'waiting'
        await pool.query(`UPDATE bot_subagents SET "activeActionId"=NULL WHERE id=$1 AND "ownerId"=$2`,[id,actor.userId])
        await store.update(actor,botId,id,'running','Approval expired; observing current page')
        return 'running'
      }
    }
    if(row.status==='needs_you') return 'waiting'
    const policy=(await pool.query('SELECT permission FROM workspace_computer_policies WHERE "workspaceId"=$1',[actor.workspaceId])).rows[0]
    if(policy?.permission==='deny') {
      await store.update(actor,botId,id,'failed','Computer permission was revoked')
      return 'terminal'
    }
    const observation=await store.action(actor,botId,id,{action:'observe'})
    const page=observation.observation as {needsLogin?:boolean;url?:string}
    if(page.url==='about:blank') {
      const initial=row.task.match(/https?:\/\/[^\s<>"')]+/)?.[0]
      if(initial) {
        const url=new URL(initial)
        if(url.username || url.password) throw new Error('Invalid starting URL')
        await store.action(actor,botId,id,{action:'navigate',url:url.toString()})
        return 'running'
      }
    }
    if(page.needsLogin && page.url) {
      const site=new URL(page.url).origin
      const {requestBrowserLogin}=await import('@/lib/cloud-computer/login-provider')
      const login=await requestBrowserLogin({...actor,botId,subagentId:id},site)
      if(login.status==='needs_approval') return 'waiting'
      const continuation=browserLoginContinuation(login.status)
      if(continuation==='running') return 'running'
      await store.update(actor,botId,id,'needs_you','Login required',{kind:'login',site})
      await report(actor,botId,id,`The web task needs the secure login card for ${site}; never request credentials in chat.`,'login')
      return 'waiting'
    }
    const {chooseVisualBrowserStep,judgeVisualBrowserAction}=await import('@/lib/cloud-computer/visual-model')
    const {hostedBillingScope}=await import('@/lib/abuse/context')
    const modelScope={workspaceId:actor.workspaceId,ownerId:actor.userId}
    const {mutationFromStep}=await import('@/lib/cloud-computer/visual-contract')
    const chosen=await hostedBillingScope.run(modelScope,()=>chooseVisualBrowserStep(row.task,row.step,observation))
    const next=chosen.next
    if(next.action==='observe') return 'running'
    const judgment=await hostedBillingScope.run(modelScope,()=>judgeVisualBrowserAction(row.task,next,chosen.observation))
    if(judgment.scope==='outside_task') {
      await store.update(actor,botId,id,'failed','Proposed browser operation is outside the requested task')
      return 'terminal'
    }
    if(judgment.scope==='needs_user_information') {
      await store.update(actor,botId,id,'needs_you',next.step)
      await report(actor,botId,id,next.summary,'question')
      return 'waiting'
    }
    if(next.action==='done') {
      await store.update(actor,botId,id,'done',next.step)
      await report(actor,botId,id,next.summary,'done')
      return 'terminal'
    }
    if(next.action==='waiting') throw new Error('browserJudgmentUnavailable')
    const {browserAction}=await import('@/lib/cloud-computer/action-reviews')
    await browserAction(pool,actor,botId,id,mutationFromStep(next),next.summary||next.step,chosen.observation,judgment)
    await pool.query(`UPDATE bot_subagents SET "consecutiveFailures"=0,"nextAttemptAt"=NULL,"lastFailureCode"=NULL,"activeSteps"="activeSteps"+1 WHERE id=$1 AND "ownerId"=$2`,[id,actor.userId])
    return 'running'
  } catch(error) {
    const message=error instanceof Error?error.message:''
    if(message==='browserActionOutcomeUnknown') {
      await report(actor,botId,id,'The last browser operation has an uncertain outcome. Do not repeat it without reconciliation.','outcome-unknown')
      return 'waiting'
    }
    const failed=await pool.query(`UPDATE bot_subagents SET "consecutiveFailures"="consecutiveFailures"+1,"lastFailureCode"=$3,"nextAttemptAt"=now()+make_interval(secs=>least(60,power(2,least("consecutiveFailures"+1,5))::int)) WHERE id=$1 AND "ownerId"=$2 AND status IN ('running','queued') RETURNING "consecutiveFailures"`,[id,actor.userId,message==='observation_stale' || message==='browserActionExpired'?'observation_changed':'runtime_unavailable'])
    if(!failed.rows[0]) return 'waiting'
    if(failed.rows[0].consecutiveFailures<4) return 'retry'
    await store.update(actor,botId,id,'failed','Browser service unavailable after bounded retries; progress retained')
    await report(actor,botId,id,'The browser task could not continue after retrying. Report the retained failure without claiming the task completed.','runtime-failed')
    return 'terminal'
  }
}
async function report(actor:Actor,botId:string,id:string,rawText:string,state:string) {
  const userId=actor.userId
  const {db,pool}=await import('@/lib/db')
  // 4e2 item 4: the report text is visual-model output persisted as a coordinator event.
  const {maskForWorkspace}=await import('@/lib/secrets/runtime')
  const text=await maskForWorkspace(actor.workspaceId,rawText)
  const {recordCoordinatorEvent}=await import('@/lib/coordinator-event-store')
  const {wakeCoordinator}=await import('@/lib/coordinator/wake')
  // A suggestion's web task reports to the chat the suggestion started in (its stored Coordinator bot row).
  const suggestion=(await pool.query<{botId:string|null}>(`SELECT e."botId" FROM suggestion_executions s JOIN coordinator_events e ON e."userId"=s."ownerId" AND e."dedupeKey"='suggestion:start:'||s."suggestionId" WHERE s."subagentId"=$1 AND s."ownerId"=$2`,[id,userId])).rows[0]
  // A web task's result is a runtime report, not the person's message: no preset tier, so triage (the Decisions API) decides whether it needs them.
  await recordCoordinatorEvent(db,{userId,botId:suggestion?suggestion.botId:botId,kind:'run_report',dedupeKey:`subagent:${id}:${state}`,issueId:null,runId:null,payload:{text:`Web task result (${state}): ${text}. Reply as the Bot in ordinary chat.`,subagentId:id,source:'subagent'}})
  await wakeCoordinator(userId)
}
export async function expire(actor:Actor,botId:string,id:string) {
  'use step'
  const {pool}=await import('@/lib/db')
  const {SubagentStore}=await import('@/lib/cloud-computer/subagents')
  await new SubagentStore(pool).stop(actor,botId,id)
}
