import 'server-only'
import type { Pool } from 'pg'
import { cleanupOwnedCloudMachines } from './cloud-cleanup'

export type EndAccountThread = (database: Pool, actor: { userId: string; workspaceId: string }, runId: string) => Promise<void>
const end: EndAccountThread = async (database, actor, runId) => {
  const { threadMachineAction } = await import('@/lib/cloud-computer/thread-machines')
  try { await threadMachineAction(database, actor, runId, 'end') }
  catch (error) {
    const { SandboxNotFoundError } = await import('e2b')
    if (!(error instanceof SandboxNotFoundError)) throw error
  }
}
/** Called only by the authorized owner's deletion job, before any runtime mapping is erased. */
export async function cleanupAccountRuntimes(ownerId: string, database: Pool, endThread = end, cleanupCloud = cleanupOwnedCloudMachines): Promise<string[]> {
  const reasons = new Set<string>()
  const threads = (await database.query<{ runId: string; workspaceId: string }>(`SELECT "runId","workspaceId" FROM thread_machines WHERE "ownerId"=$1
    AND ("sandboxId" IS NOT NULL OR state<>'ended' OR "workerLeaseId" IS NOT NULL OR "workerLeaseUntil" IS NOT NULL) ORDER BY "runId"`, [ownerId])).rows
  for (const thread of threads) {
    try { await endThread(database, { userId: ownerId, workspaceId: thread.workspaceId }, thread.runId) }
    catch { reasons.add('cloud_thread_cleanup_pending') }
  }
  for (const reason of await cleanupCloud(ownerId, database)) reasons.add(reason)
  return [...reasons]
}
