import { sleep } from 'workflow'
import * as steps from './steps'
/** Human waiting and short infrastructure retries do not exhaust the browser's
 * action budget. All counters are durable Workflow state, not in-memory timers. */
export async function webSubagentWorkflow(actor:{userId:string;workspaceId:string},botId:string,id:string) {
  'use workflow'
  let actions=0, waits=0, retries=0
  while(actions<360 && waits<20_160 && retries<1440) {
    const state=await steps.tick(actor,botId,id)
    if(state==='terminal') return
    if(state==='running') actions++
    else if(state==='waiting') waits++
    else retries++
    await sleep(state==='waiting'?'30s':state==='retry'?'5s':'1s')
  }
  await steps.expire(actor,botId,id)
}
