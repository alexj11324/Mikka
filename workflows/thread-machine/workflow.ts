import { sleep } from 'workflow'
import { maintainThreadMachine, pauseAtCap } from './steps'
export async function threadMachineLifecycle(actor: { userId: string; workspaceId: string }, runId: string) {
  'use workflow'
  // 1440 x 30s = 12 hours, the maximum lifetime GitHub Codespaces also enforces.
  // The spend guard counts wall-clock hours, so this bounds one machine's cost.
  for (let step = 0; step < 1440; step++) {
    if (!await maintainThreadMachine(actor, runId)) return
    await sleep('30s')
  }
  // Past the cap the machine is paused on purpose, never left to the provider's timeout.
  await pauseAtCap(actor, runId)
}
