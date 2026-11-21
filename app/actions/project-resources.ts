'use server'
import { z } from 'zod'
import { requireUser } from '@/lib/issue-access'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { ActionFailureError, runAction } from '@/lib/action-error'
import * as store from '@/lib/project-resources/store'
import { projectPullAuthorInput, listProjectSetupVersionsInput, rollbackProjectSetupInput, saveEnvironmentInput, listDependencyRepositoriesInput, replaceDependencyRepositoriesInput, projectDefaultEnvironmentInput, projectResourcesInput, workspaceRepositoryPolicyInput } from '@/lib/project-resources/contracts'

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
export async function setProjectDefaultEnvironment(input: z.input<typeof projectDefaultEnvironmentInput>) {
  return runAction(async () => store.setProjectDefaultEnvironment(await requireUser(), input))
}
export async function saveWorkspaceRepositoryPolicy(input: z.input<typeof workspaceRepositoryPolicyInput>) {
  return runAction(async () => store.saveWorkspaceRepositoryPolicy(await requireUser(), input))
}

export async function listProjectSetupVersions(input: z.input<typeof listProjectSetupVersionsInput>) {
  return runAction(async () => store.listProjectSetupVersions(await requireUser(), input))
}
export async function rollbackProjectSetup(input: z.input<typeof rollbackProjectSetupInput>) {
  return runAction(async () => store.rollbackProjectSetup(await requireUser(), input))
}

export async function listDependencyRepositories(input: z.input<typeof listDependencyRepositoriesInput>) {
  const store = await import('@/lib/project-resources/dependency-repositories')
  return runAction(async () => store.listDependencyRepositories(await requireUser(), input))
}
export async function replaceDependencyRepositories(input: z.input<typeof replaceDependencyRepositoriesInput>) {
  const store = await import('@/lib/project-resources/dependency-repositories')
  return runAction(async () => store.replaceDependencyRepositories(await requireUser(), input))
}

export async function searchProjectPullAuthors(input: z.input<typeof projectPullAuthorInput>) {
  const [{ withFreshSession }, { workspaceAction }, { actingContext }] = await Promise.all([
    import('@/lib/fresh-session'), import('@/lib/workspace-admin/action'), import('@/lib/activity-actor'),
  ])
  return withFreshSession(() => workspaceAction(async () => {
    if (actingContext.getStore()) throw new ActionFailureError('authRequired')
    const { projectPullAuthors } = await import('@/lib/project-resources/pull-authors')
    return { authors: await projectPullAuthors(await requireUser(), projectPullAuthorInput.parse(input)) }
  }))
}
