'use server'

import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { requireUser } from '@/lib/issue-access'
import { readProjectMap, readProjectMapNode, type ProjectMapData } from '@/lib/project-map/server'
import { listIssueThreads } from '@/app/actions/agents'
import { factoryApprovals, factoryHumanStore } from '@/lib/factory/server'
import { loadWorkspaceContext } from '@/lib/workspace-access'

function uuid(value: string, code: 'projectNotFound' | 'issueNotFound') {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success) throw new ActionFailureError(code)
  return parsed.data
}

/** A project's route for its 地图 tab (R-83): derived on read, nothing stored. */
export async function getProjectMap(projectId: string): Promise<ActionResult<{ map: ProjectMapData }>> {
  return runAction(async () => {
    const user = await requireUser()
    const id = uuid(projectId, 'projectNotFound')
    const context = await loadWorkspaceContext()
    return {
      map: await readProjectMap(user.id, id, context.workspace.id, {
        listThreads: listIssueThreads,
        listFactoryTasks: (userId, issueId) => factoryHumanStore.listForIssue(userId, issueId),
        readFactoryTask: (userId, taskId) => factoryHumanStore.read(userId, taskId),
        readLedger: (userId, taskId) => factoryApprovals.ledger({ userId }, taskId),
      }),
    }
  })
}

/** The picked node's description (the body is read only for it). */
export async function getProjectMapNode(projectId: string, issueId: string): Promise<ActionResult<{ description: string }>> {
  return runAction(async () => {
    const user = await requireUser()
    const context = await loadWorkspaceContext()
    return readProjectMapNode(user.id, uuid(projectId, 'projectNotFound'), context.workspace.id, uuid(issueId, 'issueNotFound'))
  })
}
