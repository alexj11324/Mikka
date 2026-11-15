import 'server-only'
import { ActionFailureError } from './action-error'
import { withTaskWorkspace } from './task-workspace'

export type ConversationReader = Parameters<typeof withTaskWorkspace>[0]

/** Keep the authoritative workspace membership locked until the application read or write completes. */
export async function withConversationWorkspace<T>(reader: ConversationReader, workspaceId: string, work: () => Promise<T>): Promise<T | null> {
  try {
    return await withTaskWorkspace(reader, workspaceId, work)
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') return null
    throw error
  }
}
