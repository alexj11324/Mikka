/** Separate JSON-only executor. Never sends a group assignment through the
 * repository supervisor, inherited CLI home, MCP, session resume or publisher.
 * A processor is explicitly supplied by a capability-limited host; there is
 * intentionally no default provider invocation or credential lookup. Native
 * CLI processing requires the explicit isolated image configuration. */
export interface GroupReviewAssignment {
  status: 'claimed'; runId: string; harness: 'claude_code' | 'codex'; claimEpoch: number
  envelope: { contract: 'mikka.group-review.v1'; workId: string; triggerMessageId: string; conversationId: string; instruction: string; untrustedData: unknown }
  capabilities: { tools: string[]; history: string[]; repository: null; credentials: null }
}
export type GroupReviewOutput = { body: string; proposal?: {artifactId:string;baseVersionId:string;baseHash:string;content:string} }
export interface GroupReviewLink {
  poll(): Promise<{runIds:string[]}>
  claim(runId:string): Promise<GroupReviewAssignment | {status:'cancelled'}>
  check(runId:string,claimEpoch:number): Promise<{live:boolean}>
  fail?(runId:string,claimEpoch:number):Promise<unknown>
  complete(runId:string,reply:GroupReviewOutput & {workId:string;triggerMessageId:string;claimEpoch:number}): Promise<unknown>
}
export async function runGroupReviewBatch(link:GroupReviewLink,processor:(input:GroupReviewAssignment,signal:AbortSignal)=>Promise<GroupReviewOutput>,signal?:AbortSignal) {
  const results:unknown[]=[]
  for (const runId of (await link.poll()).runIds) {
    if(signal?.aborted)break
    const claim=await link.claim(runId)
    if (claim.status!=='claimed') continue
    if (!['claude_code','codex'].includes(claim.harness) || claim.runId!==runId || claim.envelope.workId!==runId || claim.envelope.contract!=='mikka.group-review.v1' || claim.capabilities.tools.length || claim.capabilities.history.length || claim.capabilities.repository!==null || claim.capabilities.credentials!==null) throw new Error('Unsafe group assignment')
    if (!(await link.check(runId,claim.claimEpoch)).live) continue
    const controller=new AbortController()
    const abort=()=>controller.abort()
    signal?.addEventListener('abort',abort,{once:true})
    if(signal?.aborted)controller.abort()
    let checking=false
    const monitor=setInterval(()=>{
      if (checking) return
      checking=true
      void link.check(runId,claim.claimEpoch).then(state=>{if(!state.live)controller.abort()},()=>controller.abort()).finally(()=>{checking=false})
    },1000)
    const timeout=setTimeout(()=>controller.abort(),60000)
    try {
      if(controller.signal.aborted)throw new Error('Group worker stopped')
      const output=await Promise.race([processor(claim,controller.signal),new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('Group review execution stopped or lease deadline reached')),{once:true}))])
      results.push(await link.complete(runId,{body:output.body,...(output.proposal?{proposal:output.proposal}:{}),workId:claim.envelope.workId,triggerMessageId:claim.envelope.triggerMessageId,claimEpoch:claim.claimEpoch}))
    } catch(error) {
      if(!signal?.aborted)await link.fail?.(runId,claim.claimEpoch).catch(()=>undefined)
      throw error
    } finally { clearTimeout(timeout);clearInterval(monitor);signal?.removeEventListener('abort',abort);controller.abort() }
  }
  return results
}
/** Reuses the host's already authorized request function; no credential
 * creation/storage, owner/workspace identity fields or provider configuration. */
export function groupReviewHttpLink(request:(input:unknown)=>Promise<unknown>):GroupReviewLink {
  return {
    poll:()=>request({action:'poll'}) as ReturnType<GroupReviewLink['poll']>,
    claim:runId=>request({action:'claim',runId}) as ReturnType<GroupReviewLink['claim']>,
    check:(runId,claimEpoch)=>request({action:'check',runId,claimEpoch}) as ReturnType<GroupReviewLink['check']>,
    fail:(runId,claimEpoch)=>request({action:'fail',runId,claimEpoch,code:'processor_failed'}),
    complete:(runId,reply)=>request({action:'complete',runId,reply}),
  }
}
