import { handoffStage, finishQuestionWakeStep, questionWakeStillOwns } from './steps'
import { getWorkflowMetadata } from 'workflow'
import { maintainUntilCap } from '../thread-machine/lifecycle'
import type { QuestionWake } from '@/lib/factory/questions/wake'

export async function factoryCloudStageHandoff(actor: { userId: string; workspaceId: string }, previousRunId: string | null, runId: string, providerContinuation = false, questionWake?: QuestionWake) {
  'use workflow'
  const workflowRunId = questionWake ? getWorkflowMetadata().workflowRunId : undefined
  try {
    if (!await handoffStage(actor, previousRunId, runId, providerContinuation, questionWake, workflowRunId)) return
  } catch (error) {
    if (questionWake && workflowRunId) await finishQuestionWakeStep(actor, runId, questionWake, workflowRunId, true)
    throw error
  }
  if (questionWake && workflowRunId) await finishQuestionWakeStep(actor, runId, questionWake, workflowRunId, false)
  // This same durable execution owns maintenance, including after a handoff
  // step response was lost. No second lifecycle is started during step replay.
  // A newer question wake taking the run over nudges this one (workflows/wake.ts), which then stops.
  await maintainUntilCap(actor, runId, questionWake && workflowRunId ? () => questionWakeStillOwns(actor, runId, questionWake, workflowRunId) : undefined)
}
