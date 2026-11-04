import { handoffStage, finishQuestionWakeStep, questionWakeStillOwns } from './steps'
import { getWorkflowMetadata, sleep } from 'workflow'
import { maintainThreadMachine, pauseAtCap } from '../thread-machine/steps'
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
  for (let step = 0; step < 1440; step++) {
    if (questionWake && workflowRunId && !await questionWakeStillOwns(actor, runId, questionWake, workflowRunId)) return
    if (!await maintainThreadMachine(actor, runId)) return
    await sleep('30s')
  }
  await pauseAtCap(actor, runId)
}
