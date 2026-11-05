import 'server-only'

import { runAction } from './action-error'
import type { ActionResult } from './action-result'

/** Preserve expected access failures across a production Server Action's
 * redacted exception boundary. Clients must erase cached private data on these
 * answers; unexpected failures retain their original exception and cause. */
export async function cacheReadAction<T>(read: () => Promise<T>): Promise<ActionResult<T>> {
  try { return await runAction(read) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'workspaceAccessDenied') return { error: 'workspaceAccessDenied' }
    throw error
  }
}
