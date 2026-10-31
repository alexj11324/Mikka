import 'server-only'
import { pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { HostedUsageStore } from './store'
export const hostedUsage = new HostedUsageStore(pool)
/**
 * The legacy snapshot lives with workspaces, not in the application's DB.
 * Verification also belongs to the person (decision 2026-10-31-2225): a
 * personal workspace counts as verified once its owner verified any workspace
 * they own, legacy ones included, and then starts like a new sign-up, with the
 * free allowance. Without it, someone whose verified workspace became a team
 * would find their new personal workspace silently unable to run anything.
 */
export async function ensureLegacyVerification(workspaceId: string) {
  if (
    (
      await workspacePool.query(
        'SELECT 1 FROM hosted_legacy_workspaces WHERE "workspaceId"=$1',
        [workspaceId],
      )
    ).rowCount
  )
    return void (await hostedUsage.verify(workspaceId, null, null))
  const { rows: [workspace] } = await workspacePool.query<{ userId: string; kind: string }>(
    'SELECT "userId",kind FROM mikka_workspaces WHERE id=$1',
    [workspaceId],
  )
  if (workspace?.kind !== 'personal') return
  if ((await pool.query('SELECT 1 FROM hosted_verifications WHERE "workspaceId"=$1', [workspaceId])).rowCount) return
  const owned = (
    await workspacePool.query<{ id: string }>('SELECT id FROM mikka_workspaces WHERE "userId"=$1 AND id<>$2', [workspace.userId, workspaceId])
  ).rows.map(row => row.id)
  if (!owned.length) return
  const verified =
    Boolean((await workspacePool.query('SELECT 1 FROM hosted_legacy_workspaces WHERE "workspaceId"=ANY($1::uuid[])', [owned])).rowCount) ||
    Boolean((await pool.query('SELECT 1 FROM hosted_verifications WHERE "workspaceId"=ANY($1::uuid[])', [owned])).rowCount)
  if (verified) await hostedUsage.verify(workspaceId, null, null)
}
export async function canUseMikkaPaid(workspaceId: string) {
  await ensureLegacyVerification(workspaceId)
  return hostedUsage.canUseMikkaPaid(workspaceId)
}
