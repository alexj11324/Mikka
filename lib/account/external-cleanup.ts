import 'server-only'
import type { Pool } from 'pg'
import { pool } from '@/lib/db'
import { getComposio, retireComposioAccount } from '@/lib/composio'
import { listComposioPages } from '@/lib/composio-pagination'
import { cleanupAccountSubscriptions } from './subscription-cleanup'
import { cleanupAccountRuntimes } from './runtime-cleanup'

/** No provider contents are deleted. Managed authorization must be revoked before its local mapping goes. */
export async function cleanupAccountConnections(ownerId: string, database: Pool): Promise<string[]> {
  // Remote adapters resolve custody/key material through the current server scope.
  // A restore or caller-supplied SQL target must use explicit adapters, never ambient remote credentials.
  if (database.options.connectionString !== pool.options.connectionString || database.options.options !== pool.options.options) return ['external_cleanup_target_mismatch']
  const blocked: string[] = []
  const cached = (await database.query('SELECT "accountId" FROM composio_accounts WHERE "userId"=$1', [ownerId])).rows
  const composio = getComposio()
  if (!composio && cached.length) blocked.push('composio_not_configured')
  if (composio) {
    const accounts = await listComposioPages(cursor => composio.connectedAccounts.list({ userIds: [ownerId], cursor }))
    // Listing is scoped by the trusted provider's owner filter, never caller IDs.
    for (const account of accounts) await retireComposioAccount(composio, ownerId, account.id, 'disconnect')
  }
  blocked.push(...await cleanupAccountSubscriptions(ownerId, database))
  blocked.push(...await cleanupAccountRuntimes(ownerId, database))
  return [...new Set(blocked)]
}
