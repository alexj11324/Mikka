import 'server-only'
import type { Pool } from 'pg'
import { getComposio, retireComposioAccount } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'

/** No provider contents are deleted. Managed authorization must be revoked before its local mapping goes. */
export async function cleanupAccountConnections(ownerId: string, database: Pool): Promise<string[]> {
  const blocked: string[] = []
  const cached = (await database.query('SELECT "accountId" FROM composio_accounts WHERE "userId"=$1', [ownerId])).rows
  const composio = getComposio()
  if (!composio && cached.length) blocked.push('composio_not_configured')
  if (composio) {
    const accounts = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [ownerId], cursor }))
    // Listing is scoped by the trusted provider's owner filter, never caller IDs.
    for (const account of accounts) await retireComposioAccount(composio, ownerId, account.id, 'disconnect')
  }
  const byos = (await database.query(`SELECT 1 FROM byos_connections c WHERE c."ownerId"=$1 AND (
    c."secretName" IS NOT NULL OR c."accessSecretName" IS NOT NULL OR c."stagedSecretName" IS NOT NULL OR c."stagedAccessName" IS NOT NULL
    OR EXISTS(SELECT 1 FROM byos_secret_artifacts a WHERE a."connectionId"=c.id AND a."deletedAt" IS NULL)) LIMIT 1`, [ownerId])).rowCount
  if (byos) blocked.push('subscription_custody_cleanup_required')
  // Runtime-owned files require an acknowledged owner-bound teardown, not deletion of a DB pointer.
  const cloud = (await database.query('SELECT 1 FROM cloud_machines WHERE "ownerId"=$1 AND ("sandboxId" IS NOT NULL OR "provisionLeaseId" IS NOT NULL) UNION ALL SELECT 1 FROM thread_machines WHERE "ownerId"=$1 AND ("sandboxId" IS NOT NULL OR state<>\'ended\') LIMIT 1', [ownerId])).rowCount
  if (cloud) blocked.push('cloud_runtime_cleanup_required')
  return blocked
}
