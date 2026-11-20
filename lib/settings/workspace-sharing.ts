import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import type { ResolvedShareVisibility, WorkspaceSharingDefaults } from '@mikka/protocol/settings'
import { workspaceSettingValues } from './schema'
import { resolveSettingValue } from './registry'

/** Internal reader: the caller already holds the resource's workspace admission.
 * Defaults choose a new share's scope; they never grant access to the resource. */
export async function readWorkspaceSharingDefaults(workspaceId: string): Promise<WorkspaceSharingDefaults> {
  const rows = await db.select({ key: workspaceSettingValues.key, value: workspaceSettingValues.textValue })
    .from(workspaceSettingValues).where(eq(workspaceSettingValues.workspaceId, workspaceId))
  const resolve = (key: string) => resolveSettingValue(key, null, rows.find(row => row.key === key)?.value) as ResolvedShareVisibility
  return { thread: resolve('threadShareVisibility'), artifact: resolve('artifactShareVisibility') }
}
