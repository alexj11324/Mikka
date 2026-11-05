import * as steps from './steps'
import { workflowWakes } from '../wake'
import { wakeTokens } from '@/lib/workflow-wake-tokens'

/** A waiting task (a person to answer, an approval, a free slot, computer use
 * denied) is woken by its row changing (lib/cloud-computer/subagents.ts); this
 * re-check only covers a lost wake. It was a 30 s tick. */
export const SUBAGENT_WAIT_FALLBACK_MS = 2 * 60_000
/** A task left waiting this long expires, as the 20,160 ticks of 30 s did. */
export const SUBAGENT_WAIT_BUDGET_MS = 7 * 24 * 60 * 60_000
/** Between two browser actions the page gets a second to settle: pacing work, not a poll. */
export const SUBAGENT_SETTLE_MS = 1_000

/** Human waiting and short infrastructure retries do not exhaust the browser's
 * action budget. All counters are durable Workflow state, not in-memory timers. */
export async function webSubagentWorkflow(actor:{userId:string;workspaceId:string},botId:string,id:string) {
  'use workflow'
  const until=workflowWakes(wakeTokens.subagent(id))
  let actions=0, retries=0, waited=0
  while(actions<360 && waited<SUBAGENT_WAIT_BUDGET_MS && retries<1440) {
    const state=await steps.tick(actor,botId,id)
    if(state==='terminal') return
    const from=Date.now()
    if(state==='running') { actions++; await until(from+SUBAGENT_SETTLE_MS) }
    else if(state==='waiting') { await until(from+SUBAGENT_WAIT_FALLBACK_MS); waited+=Date.now()-from }
    // The row's own backoff (2 s doubling, at most 60 s) decides when to try again.
    else { retries++; await until(state.retryAt) }
  }
  await steps.expire(actor,botId,id)
}
