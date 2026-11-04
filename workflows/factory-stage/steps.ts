export async function handoffStage(actor: { userId: string; workspaceId: string }, previousRunId: string | null, runId: string) {
  'use step'
  const [{ pool }, { handoffFactoryCloudStage }] = await Promise.all([import('@/lib/db'), import('@/lib/factory/cloud-stage-handoff')])
  console.info(JSON.stringify({ event: 'factory_cloud_handoff', runId, previousRunId }))
  const started = await handoffFactoryCloudStage(pool, actor, previousRunId, runId)
  console.info(JSON.stringify({ event: 'factory_cloud_handoff_finished', runId, started }))
  return started
}
