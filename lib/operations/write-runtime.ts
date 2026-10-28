import 'server-only'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { getComposio } from '@/lib/composio'
import { createApprovedWrites } from './approved-writes'
import { composioWriteProvider } from './write-provider'
import type { WriteRequestContext } from './write-transaction'
import type { WriteActionName } from './write-contract'
import { createApprovedWriteDiscovery } from './write-discovery'

/** Reuses the application's personal-account auth and shared pool. No new
 * approval table, connection selector, user-supplied owner or worker authority.
 * No verified Slack contract or atomic Calendar transport is configured here. */
export function personalWriteRuntime() {
  return {
    auth,
    discovery: createApprovedWriteDiscovery(pool),
    operations: (action: WriteActionName, context?: WriteRequestContext) => createApprovedWrites(pool, composioWriteProvider(getComposio(), action), action, context),
  }
}
