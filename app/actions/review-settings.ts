'use server'

import { currentWorkspaceActor } from '@/lib/workspace-admin/current'
import { settingsWorkspaceAction } from '@/lib/workspace-admin/settings-action'
import { getReviewRepositories, saveReviewRepository, deleteReviewRepository } from '@/lib/code-review/repositories'
import { ScheduleError } from '@/lib/schedules/contract'

async function action<T>(work: () => Promise<T>) {
  try { return await settingsWorkspaceAction(work) }
  catch (error) { if (error instanceof ScheduleError) return { error: error.code, status: error.status }; throw error }
}
export async function getCodeReviewRepositories(workspaceId: string) {
  return action(async () => getReviewRepositories(await currentWorkspaceActor(workspaceId)))
}
export async function saveCodeReviewRepository(workspaceId: string, raw: unknown) {
  return action(async () => saveReviewRepository(await currentWorkspaceActor(workspaceId), raw))
}
export async function deleteCodeReviewRepository(workspaceId: string, raw: unknown) {
  return action(async () => deleteReviewRepository(await currentWorkspaceActor(workspaceId), raw))
}
