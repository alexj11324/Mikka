import { withThreadWorkflowAuthority } from '@/lib/enterprise/execution-authority'
import type { QuestionWake } from '@/lib/factory/questions/wake'

export async function handoffStage(actor: { userId: string; workspaceId: string }, previousRunId: string | null, runId: string, providerContinuation = false, questionWake?: QuestionWake, workflowRunId?: string) {
  'use step'
  return withThreadWorkflowAuthority(actor, runId, async () => {
    const [{ pool }, { handoffFactoryCloudStage }] = await Promise.all([import('@/lib/db'), import('@/lib/factory/cloud-stage-handoff')])
    if (questionWake) {
      if (!workflowRunId) return false
      const { claimQuestionWake, questionWakeClaimed } = await import('@/lib/factory/questions/wake')
      if (await questionWakeClaimed(pool, actor, runId, questionWake, workflowRunId)) return true
      if (!await claimQuestionWake(pool, actor, runId, questionWake, workflowRunId)) return false
    }
    console.info(JSON.stringify({ event: 'factory_cloud_handoff', runId, previousRunId, providerContinuation }))
    const started = await handoffFactoryCloudStage(pool, actor, previousRunId, runId, providerContinuation)
    console.info(JSON.stringify({ event: 'factory_cloud_handoff_finished', runId, started }))
    return started
  })
}

export async function finishQuestionWakeStep(actor: { userId: string; workspaceId: string }, runId: string, wake: QuestionWake, workflowRunId: string, failed: boolean) {
  'use step'
  const [{ pool }, { finishQuestionWake }] = await Promise.all([import('@/lib/db'), import('@/lib/factory/questions/wake')])
  await finishQuestionWake(pool, actor, runId, wake, workflowRunId, failed)
}

export async function questionWakeStillOwns(actor: { userId: string; workspaceId: string }, runId: string, wake: QuestionWake, workflowRunId: string) {
  'use step'
  const [{ pool }, { questionWakeOwnsWorkflow }] = await Promise.all([import('@/lib/db'), import('@/lib/factory/questions/wake')])
  return questionWakeOwnsWorkflow(pool, actor, runId, wake, workflowRunId)
}
