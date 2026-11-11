import 'server-only'
import { cookies } from 'next/headers'
import { actingContext } from '@/lib/activity-actor'
import { activeTaskWorkspaces, withTaskWorkspace } from '@/lib/task-workspace'
import { actAs } from '@/lib/acting-user'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError } from '@/lib/workspace-error'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { FactoryError } from './contract'
import { currentRequestScope } from '@/apps/api/src/context'
import { workspaceSelection } from '@/lib/workspace-selection'
import { withProjectResourceLease } from '@/lib/project-resources/store'

/** Human Factory requests use the selected tenant. Background workers retain
 * their stored task/Bot authority, and scoped credentials retain their pin. */
export async function factoryWorkspaceReader(userId: string) {
  const acting = actingContext.getStore()
  const selection = workspaceSelection(currentRequestScope()?.headers)
  if (acting?.userId === userId && selection.present && (!selection.workspaceId
    || acting.tokenWorkspaceId && acting.tokenWorkspaceId !== selection.workspaceId)) throw new FactoryError('factoryNotFound')
  if (acting?.userId !== userId) return userId
  const reader = { id: userId, [enterprisePrincipal]: acting.enterprisePrincipal }
  if (acting.tokenWorkspaceId) return { ...reader, [tokenWorkspace]: acting.tokenWorkspaceId }
  if (acting.enterprisePrincipal?.kind !== 'session') return userId
  // Do not fetch an account or create a personal workspace while the Factory
  // transaction holds an app-pool connection. Existing task reads only need
  // the ordered active membership choices and the request's selection.
  const choices = await activeTaskWorkspaces(reader, selection.workspaceId ?? undefined)
  const saved = selection.present ? undefined : (await cookies()).get('mikka-workspace')?.value
  const selected = selection.present ? choices.find(workspace => workspace.id === selection.workspaceId)
    : choices.find(workspace => workspace.id === saved)
      ?? choices.find(workspace => workspace.kind === 'personal')
      ?? choices[0]
  if (!selected) throw new FactoryError('factoryNotFound')
  return { ...reader, [tokenWorkspace]: selected.id }
}

type WorkspaceAdmission<T> = (reader: Parameters<typeof withTaskWorkspace>[0], workspaceId: string, work: () => Promise<T>) => Promise<T>

/** Both admissions select once, retain the verified principal, and map a stale
 * membership to the same non-disclosing Factory response. */
async function withFactoryAdmission<T>(userId: string, work: () => Promise<T>, admit: WorkspaceAdmission<T>): Promise<T> {
  try {
    const acting = actingContext.getStore()
    if (acting?.userId !== userId || !acting.enterprisePrincipal) throw new FactoryError('factoryNotFound')
    const reader = await factoryWorkspaceReader(userId)
    if (typeof reader === 'string' || !reader[tokenWorkspace]) throw new FactoryError('factoryNotFound')
    return await admit(reader, reader[tokenWorkspace], () => actAs(reader, work, acting.actor))
  } catch (error) {
    if ((error instanceof ActionFailureError || error instanceof WorkspaceError) && error.code === 'workspaceAccessDenied') {
      throw new FactoryError('factoryNotFound', { cause: error })
    }
    throw error
  }
}

/** Human execution callers hold membership and Project resources before APP.
 * Nested dispatch, approval and acceptance consumers retain this default. */
export function withFactoryWorkspace<T>(userId: string, work: () => Promise<T>): Promise<T> {
  return withFactoryAdmission(userId, work, (reader, workspaceId, run) =>
    withTaskWorkspace(reader, workspaceId, () => withProjectResourceLease(reader, workspaceId, run)))
}

/** Profile management holds live membership through its APP transaction, but
 * does not admit a Run or acquire a Project execution resource lease. */
export function withFactoryMembership<T>(userId: string, work: () => Promise<T>): Promise<T> {
  return withFactoryAdmission(userId, work, (reader, workspaceId, run) => withTaskWorkspace(reader, workspaceId, run))
}
