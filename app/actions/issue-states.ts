'use server'

import type { ActionResult } from '@/lib/action-result'
import { activityActor } from '@/lib/activity-actor'
import { db } from '@/lib/db'
import { workspaceAction } from '@/lib/workspace-admin/action'
import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { WorkspaceError } from '@/lib/workspace-error'
import { createIssueStateInput, deleteIssueStateInput, reorderIssueStatesInput, setDefaultIssueStateInput, updateIssueStateInput, type CreateIssueStateInput, type DeleteIssueStateInput, type IssueStateView, type ReorderIssueStatesInput, type SetDefaultIssueStateInput, type UpdateIssueStateInput } from '@/lib/issue-states'
import { createIssueState, deleteIssueState, listIssueStates, reorderIssueStates, setDefaultIssueState, updateIssueState } from '@/lib/issue-states-store'

export interface IssueStatesView { states: IssueStateView[]; canEdit: boolean }

/** 任务状态: every member reads them (board, picker); admins edit them. */
export async function getIssueStates(workspaceId: string): Promise<ActionResult<IssueStatesView>> {
  return workspaceAction(async () => {
    const actor = await currentWorkspaceActor(workspaceId)
    return { states: await listIssueStates(db, actor.workspaceId), canEdit: actor.role === 'admin' }
  })
}

/** Admins only. The workspace in the input is checked against the actor's membership and role. */
async function asAdmin<T extends { workspaceId: string }>(input: T): Promise<{ userId: string; input: T }> {
  const actor = await currentWorkspaceActor(input.workspaceId)
  if (actor.role !== 'admin' || actor.workspaceId !== input.workspaceId) throw new WorkspaceError('workspaceAccessDenied')
  return { userId: actor.userId, input }
}

export async function createWorkspaceIssueState(input: CreateIssueStateInput): Promise<ActionResult<{ id: string }>> {
  return workspaceAction(async () => createIssueState((await asAdmin(createIssueStateInput.parse(input))).input))
}

export async function updateWorkspaceIssueState(input: UpdateIssueStateInput): Promise<ActionResult<{ ok: true }>> {
  return workspaceAction(async () => {
    await updateIssueState((await asAdmin(updateIssueStateInput.parse(input))).input)
    return { ok: true as const }
  })
}

export async function reorderWorkspaceIssueStates(input: ReorderIssueStatesInput): Promise<ActionResult<{ ok: true }>> {
  return workspaceAction(async () => {
    await reorderIssueStates((await asAdmin(reorderIssueStatesInput.parse(input))).input)
    return { ok: true as const }
  })
}

export async function setDefaultWorkspaceIssueState(input: SetDefaultIssueStateInput): Promise<ActionResult<{ ok: true }>> {
  return workspaceAction(async () => {
    await setDefaultIssueState((await asAdmin(setDefaultIssueStateInput.parse(input))).input)
    return { ok: true as const }
  })
}

/** Capy's MoveAndDelete: the state's tasks move to `moveTo` first. */
export async function deleteWorkspaceIssueState(input: DeleteIssueStateInput): Promise<ActionResult<{ moved: number }>> {
  return workspaceAction(async () => {
    const { userId, input: parsed } = await asAdmin(deleteIssueStateInput.parse(input))
    return deleteIssueState(parsed, activityActor(userId))
  })
}
