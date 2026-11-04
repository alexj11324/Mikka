import { handoffStage } from './steps'
import { sleep } from 'workflow'
import { maintainThreadMachine, pauseAtCap } from '../thread-machine/steps'

export async function factoryCloudStageHandoff(actor: { userId: string; workspaceId: string }, previousRunId: string | null, runId: string) {
  'use workflow'
  if (!await handoffStage(actor, previousRunId, runId)) return
  // This same durable execution owns maintenance, including after a handoff
  // step response was lost. No second lifecycle is started during step replay.
  for (let step = 0; step < 1440; step++) {
    if (!await maintainThreadMachine(actor, runId)) return
    await sleep('30s')
  }
  await pauseAtCap(actor, runId)
}
