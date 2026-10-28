import 'server-only'
import { start } from 'workflow/api'
import { publicationDelivery, rememberPublicationWorkflow } from '@/lib/run-publications'
import { runPublication } from '@/workflows/run-publication/workflow'

/**
 * The completion route waits for durable enqueue before acknowledging the
 * daemon outbox. A crash around start can enqueue twice; DB leases and the
 * GitHub issue marker make both executions converge on the same receipt.
 */
export async function startRunPublication(runId: string) {
  const row = await publicationDelivery(runId)
  if (!row || row.workflowRunId || !['pending', 'processing'].includes(row.status)) return
  const workflow = await start(runPublication, [runId])
  await rememberPublicationWorkflow(runId, workflow.runId)
}
