import { sleep } from 'workflow'
import { maintainThreadMachine } from './steps'
export async function threadMachineLifecycle(actor: { userId: string; workspaceId: string }, runId: string) {
  'use workflow'
  for (let step = 0; step < 2880; step++) {
    if (!await maintainThreadMachine(actor, runId)) return
    await sleep('30s')
  }
}
