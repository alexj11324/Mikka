import { handoffStage } from './steps'

export async function factoryCloudStageHandoff(actor: { userId: string; workspaceId: string }, previousRunId: string | null, runId: string) {
  'use workflow'
  await handoffStage(actor, previousRunId, runId)
}
