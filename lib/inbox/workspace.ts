import { ActionFailureError } from '@/lib/action-error'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { InboxError } from './contract'
import type { Guard } from './store'

/** Hold the canonical membership and Enterprise admission until the inbox work
 * finishes. Preserve the original reader's session/token provenance throughout. */
export function createInboxGuard(admit: typeof withTaskWorkspace = withTaskWorkspace): Guard {
  return async (reader, workspaceId, work) => {
    try {
      return await admit(reader, workspaceId, workspace => work({ personal: workspace.kind === 'personal' }))
    } catch (error) {
      if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') throw new InboxError('workspaceAccessDenied', 403, { cause: error })
      throw error
    }
  }
}
