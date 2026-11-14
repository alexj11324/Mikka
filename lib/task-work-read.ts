import 'server-only'
import { actAs } from './acting-user'
import { pool } from './db'
import { readFactoryActivity } from './factory/activity'
import { FactoryError } from './factory/contract'
import { factoryHumanStore } from './factory/server'
import { withFactoryWorkspace } from './factory/workspace-reader'
import { readTaskPresentations } from './task-presentation-read'

/** Reuse the detail reader's tenant and Factory checks, including revocation between the two reads. */
export async function readTaskWork(user: Parameters<typeof readTaskPresentations>[0], workspaceId: string, issueId: string) {
  const batch = await readTaskPresentations(user, { workspaceId, issueIds: [issueId], includeFactoryIdentity: true })
  const presentation = batch.items[issueId] ?? null
  if (!presentation?.factoryTaskId) return { presentation, factory: null }
  const taskId = presentation.factoryTaskId
  try {
    const activity = await actAs(user, () => withFactoryWorkspace(user.id, () => readFactoryActivity(pool, factoryHumanStore, user.id, taskId)))
    const factory = activity.task.issueId === issueId && activity.task.id === taskId ? { ...activity, liveWorkspaceId: workspaceId } : null
    return { presentation, factory }
  } catch (error) {
    if (!(error instanceof FactoryError) || error.code !== 'factoryNotFound') throw error
    return { presentation: null, factory: null }
  }
}
