import 'server-only'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { HostedUsageStore } from './store'
export const hostedUsage = new HostedUsageStore(pool)
/** The legacy snapshot lives with workspaces, not in the application's DB. */
export async function ensureLegacyVerification(workspaceId: string) {
  if (
    (
      await workspacePool.query(
        'SELECT 1 FROM hosted_legacy_workspaces WHERE "workspaceId"=$1',
        [workspaceId],
      )
    ).rowCount
  )
    await hostedUsage.verify(workspaceId, null, null)
}
export async function canUseMikkaPaid(workspaceId: string) {
  await ensureLegacyVerification(workspaceId)
  return hostedUsage.canUseMikkaPaid(workspaceId)
}
