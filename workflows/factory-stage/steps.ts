export async function handoffStage(actor: { userId: string; workspaceId: string }, previousRunId: string | null, runId: string, providerContinuation = false) {
  'use step'
  const [{ pool }, { handoffFactoryCloudStage }] = await Promise.all([import('@/lib/db'), import('@/lib/factory/cloud-stage-handoff')])
  console.info(JSON.stringify({ event: 'factory_cloud_handoff', runId, previousRunId, providerContinuation }))
  const started = await handoffFactoryCloudStage(pool, actor, previousRunId, runId, providerContinuation)
  console.info(JSON.stringify({ event: 'factory_cloud_handoff_finished', runId, started }))
  return started
}
