import { sleep } from 'workflow'
import * as steps from './steps'
/** One durable workflow per web task; queued tasks wait for the workspace cap. */
export async function webSubagentWorkflow(actor: { userId: string; workspaceId: string }, botId: string, id: string) {
  'use workflow'
  for (let turn = 0; turn < 360; turn++) {
    const state = await steps.tick(actor, botId, id)
    if (state === 'terminal') return
    await sleep(state === 'waiting' ? '10s' : '1s')
  }
  await steps.expire(actor, botId, id)
}
