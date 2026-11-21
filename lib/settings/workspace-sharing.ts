import 'server-only'
import { db } from '@/lib/db'
import type { WorkspaceSharingDefaults } from '@mikka/protocol/settings'
import { readRuntimeSettings } from './runtime'

/** Internal reader: the caller already holds the resource's workspace admission.
 * Defaults choose a new share's scope; they never grant access to the resource. */
export async function readWorkspaceSharingDefaults(workspaceId: string): Promise<WorkspaceSharingDefaults> {
  const { threadShareVisibility: thread, artifactShareVisibility: artifact } =
    await readRuntimeSettings(db, ['threadShareVisibility', 'artifactShareVisibility'], { workspaceId })
  return { thread, artifact }
}
