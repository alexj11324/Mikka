import 'server-only'
import { cookies } from 'next/headers'
import { actingContext } from '@/lib/activity-actor'
import { activeTaskWorkspaces } from '@/lib/task-workspace'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { FactoryError } from './contract'

/** Human Factory requests use the selected tenant. Background workers retain
 * their stored task/Bot authority, and scoped credentials retain their pin. */
export async function factoryWorkspaceReader(userId: string) {
  const acting = actingContext.getStore()
  if (acting?.userId !== userId || acting.tokenWorkspaceId || acting.enterprisePrincipal?.kind !== 'session') return userId
  // Do not fetch an account or create a personal workspace while the Factory
  // transaction holds an app-pool connection. Existing task reads only need
  // the ordered active membership choices and the request's selection.
  const choices = await activeTaskWorkspaces(userId)
  const saved = (await cookies()).get('mikka-workspace')?.value
  const selected = choices.find(workspace => workspace.id === saved) ?? choices[0]
  if (!selected) throw new FactoryError('factoryNotFound')
  return { id: userId, [tokenWorkspace]: selected.id, [enterprisePrincipal]: acting.enterprisePrincipal }
}
