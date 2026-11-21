import 'server-only'
import type { Pool } from 'pg'
import { pool } from '@/lib/db'
import { getComposio, retireComposioAccount } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import type { AccountCleanupReport, AccountDeletionLease } from './cleanup-result'
import { cleanupAccountSubscriptions } from './subscription-cleanup'
import { cleanupAccountBilling } from './billing-cleanup'
import { cleanupAccountRuntimes } from './runtime-cleanup'

/**
 * No provider contents are deleted. Managed authorization must be revoked before its local mapping goes.
 * `soloWorkspaceIds` are the workspaces this deletion removes (Plan.solo); their paid plans must be
 * cancelled here, before the delete path takes the only entry point that could cancel them.
 */
export async function cleanupAccountConnections(ownerId: string, database: Pool, job?: AccountDeletionLease, soloWorkspaceIds: readonly string[] = []): Promise<AccountCleanupReport> {
  // Remote adapters resolve custody/key material through the current server scope.
  // A restore or caller-supplied SQL target must use explicit adapters, never ambient remote credentials.
  if (database.options.connectionString !== pool.options.connectionString || database.options.options !== pool.options.options) return { blockedReasons: ['external_cleanup_target_mismatch'], warnings: [] }
  const blocked: string[] = [], warnings: string[] = []
  // Billing goes first: a card that keeps being charged outlives every local row this job removes.
  const billing = await cleanupAccountBilling(database, { soloWorkspaceIds })
  blocked.push(...billing.blockedReasons); warnings.push(...billing.warnings)
  const cached = (await database.query('SELECT "accountId" FROM composio_accounts WHERE "userId"=$1', [ownerId])).rows
  const composio = getComposio()
  if (!composio && cached.length) blocked.push('composio_not_configured')
  if (composio) {
    const accounts = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [ownerId], cursor }))
    // Listing is scoped by the trusted provider's owner filter, never caller IDs.
    for (const account of accounts) await retireComposioAccount(composio, ownerId, account.id, 'disconnect')
    if (accounts.length) warnings.push('composio_upstream_revocation_may_complete_asynchronously')
  }
  const subscription = await cleanupAccountSubscriptions(ownerId, database, undefined, job)
  blocked.push(...subscription.blockedReasons); warnings.push(...subscription.warnings)
  const blockerErrors = { ...subscription.blockerErrors }
  blocked.push(...await cleanupAccountRuntimes(ownerId, database, { job, blockerErrors }))
  return { blockedReasons: [...new Set(blocked)], warnings: [...new Set(warnings)], ...(Object.keys(blockerErrors).length ? { blockerErrors } : {}) }
}
