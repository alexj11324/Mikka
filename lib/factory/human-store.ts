import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { FactoryError } from './contract'
import type { createFactoryStore, FactoryCompletionDispatch } from './store'
import type { ObserveRetainedDeliverable } from './deliverable-recovery'

type Store = ReturnType<typeof createFactoryStore>

/** Human APIs select the task's persisted Bot; model/runtime stores retain their fixed Bot scope. */
export function createFactoryHumanStore(pool: Pool, forBot: (botId: string | null) => Store, dispatchCompleted?: FactoryCompletionDispatch, observeRetained?: ObserveRetainedDeliverable): Store {
  const base = forBot(null)
  async function taskStore(userId: string, taskId: string, tx: Pick<PoolClient, 'query'> = pool, sharedRead = false) {
    if (!z.uuid().safeParse(taskId).success) throw new FactoryError('factoryNotFound')
    const { rows: [task] } = await tx.query('SELECT "botId" FROM factory_tasks WHERE id=$1 AND ("userId"=$2 OR $3::boolean)', [taskId, userId, sharedRead])
    if (!task) throw new FactoryError('factoryNotFound')
    // The canonical store still checks current issue visibility, source and Bot ownership.
    return forBot(task.botId)
  }
  return {
    ...base,
    readTask: async (tx, userId, taskId) => (await taskStore(userId, taskId, tx, true)).readTask(tx, userId, taskId),
    read: async (userId, taskId) => (await taskStore(userId, taskId, pool, true)).read(userId, taskId),
    recheckCandidate: async (userId, binding, eventId, reason) => {
      const result = await (await taskStore(userId, binding.taskId)).recheckCandidate(userId, binding, eventId, reason, dispatchCompleted)
      await result.start?.()
      return result
    },
    lockTask: async (tx, userId, taskId) => (await taskStore(userId, taskId, tx)).lockTask(tx, userId, taskId),
    apply: async (userId, binding, eventId, change, tx) => {
      const store = await taskStore(userId, binding.taskId, tx ?? pool)
      if (!tx && change.action === 'retry') {
        const check = await store.retryCheckStart(userId, binding, eventId, change.reason, dispatchCompleted)
        if (check) { await check.start?.(); return check.result }
        if (observeRetained) {
          const recovered = await store.retryDeliverableSnapshot(userId, binding, eventId, change.reason, observeRetained, dispatchCompleted)
          if (recovered) { await recovered.start?.(); return recovered.result }
        }
        const completed = await store.retryCompletion(userId, binding, eventId, change.reason, dispatchCompleted)
        if (completed) { await completed.start?.(); return completed.result }
      }
      return store.apply(userId, binding, eventId, change, tx)
    },
    // Every Bot's tasks of the issue in one transaction: one issue lock and access check, not one per Bot.
    listForIssue: (userId, issueId) => base.listForIssue(userId, issueId, { anyBot: true }),
  }
}
