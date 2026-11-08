'use server'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { runAction } from '@/lib/action-error'
import * as store from '@/lib/project-resources/store'
import { saveEnvironmentInput, projectResourcesInput, workspaceRepositoryPolicyInput } from '@/lib/project-resources/contracts'

export async function listProjectResources(workspaceId: string, projectId?: string) {
  const user = await requireUser()
  const context = await loadWorkspaceContext(z.uuid().parse(workspaceId), user)
  return store.listProjectResources(user, context.workspace.id, projectId ? z.uuid().parse(projectId) : undefined)
}
export async function saveEnvironment(input: z.input<typeof saveEnvironmentInput>) {
  return runAction(async () => store.saveEnvironment(await requireUser(), input))
}
export async function saveProjectResources(input: z.input<typeof projectResourcesInput>) {
  return runAction(async () => store.saveProjectResources(await requireUser(), input))
}
export async function saveWorkspaceRepositoryPolicy(input: z.input<typeof workspaceRepositoryPolicyInput>) {
  return runAction(async () => store.saveWorkspaceRepositoryPolicy(await requireUser(), input))
}
