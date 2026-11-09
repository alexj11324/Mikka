import type { Pool } from 'pg'
import type { createFactoryDispatch } from '../../lib/factory/dispatch'
import type { createFactoryReconciler } from '../../lib/factory/reconcile'
import type { FactoryWorkspaceBoundary } from '../../lib/factory/background-workspace'

/** Component fixtures still use the actual host's persisted tenant and resource
 * lease. Never manufacture an admission result or acquire WS after APP BEGIN. */
export const factoryResourceWorkspace = (pool: Pick<Pool, 'query'>): FactoryWorkspaceBoundary =>
  async (userId, taskId, work, existing) => {
    const { withFactoryBackgroundWorkspace } = await import('../../lib/factory/background-workspace')
    return withFactoryBackgroundWorkspace(pool, userId, { kind: 'task', id: taskId }, work, existing)
  }

export function resourceBoundFactoryDispatch(pool: Pick<Pool, 'query'>, dispatch: ReturnType<typeof createFactoryDispatch>): ReturnType<typeof createFactoryDispatch> {
  return async (...args) => {
    const { factoryBackgroundReference } = await import('../../lib/factory/background-workspace')
    return factoryResourceWorkspace(pool)(args[0], factoryBackgroundReference(args[1], 'taskId'), () => dispatch(...args), args[2])
  }
}

export const resourceBoundDispatchConstructor = (create: typeof createFactoryDispatch): typeof createFactoryDispatch =>
  (...args) => resourceBoundFactoryDispatch(args[0], create(...args))

export const resourceBoundReconcilerConstructor = (create: typeof createFactoryReconciler): typeof createFactoryReconciler =>
  (pool, store, questions, consumers, botId, automatic, boundary) =>
    create(pool, store, questions, consumers, botId, automatic, boundary ?? factoryResourceWorkspace(pool))
