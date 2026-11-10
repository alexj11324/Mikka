import { afterDatabaseCommit } from '../db/commit-effects'
import { scheduleLive, sendLiveInvalidations } from './notify'

/** Only the already-authorized audience and explicitly removed members get
 * this opaque Workspace invalidation. No private resource ID enters the push. */
export function notifyResourceAccessChanged(executor: object, workspaceId: string, subjectIds: readonly string[]) {
  for (const ownerId of new Set(subjectIds)) afterDatabaseCommit(executor,`resource-access:${workspaceId}:${ownerId}`,()=>scheduleLive(
    () => sendLiveInvalidations({ ownerId,workspaceId },[{kind:'resource_access',id:workspaceId}]),
  ))
}
