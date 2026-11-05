import { maintainUntilCap } from './lifecycle'

export async function threadMachineLifecycle(actor: { userId: string; workspaceId: string }, runId: string) {
  'use workflow'
  await maintainUntilCap(actor, runId)
}
