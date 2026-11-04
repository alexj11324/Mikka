import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { FactoryError } from './contract'
import type { createFactoryStore, FactoryCompletionDispatch } from './store'

type Store = ReturnType<typeof createFactoryStore>

/** Human APIs select the task's persisted Bot; model/runtime stores retain their fixed Bot scope. */
export function createFactoryHumanStore(pool: Pool, forBot: (botId: string | null) => Store, dispatchCompleted?: FactoryCompletionDispatch): Store {
  const base = forBot(null)
  async function taskStore(userId: string, taskId: string, tx: Pick<PoolClient, 'query'> = pool) {
    if (!z.uuid().safeParse(taskId).success) throw new FactoryError('factoryNotFound')
    const { rows: [task] } = await tx.query('SELECT "botId" FROM factory_tasks WHERE id=$1 AND "userId"=$2', [taskId, userId])
    if (!task) throw new FactoryError('factoryNotFound')
    // The canonical store still checks current issue visibility, source and Bot ownership.
    return forBot(task.botId)
  }
  return {
    ...base,
    read: async (userId, taskId) => (await taskStore(userId, taskId)).read(userId, taskId),
    lockTask: async (tx, userId, taskId) => (await taskStore(userId, taskId, tx)).lockTask(tx, userId, taskId),
    apply: async (userId, binding, eventId, change, tx) => {
      const store = await taskStore(userId, binding.taskId, tx ?? pool)
      if (!tx && change.action === 'retry') {
        const completed = await store.retryCompletion(userId, binding, eventId, change.reason, dispatchCompleted)
        if (completed) { await completed.start?.(); return completed.result }
      }
      return store.apply(userId, binding, eventId, change, tx)
    },
    async listForIssue(userId, issueId) {
      const empty = await base.listForIssue(userId, issueId)
      const { rows } = await pool.query('SELECT id,"botId" FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2 ORDER BY "updatedAt" DESC,id DESC LIMIT 50', [userId, issueId])
      const tasks = [...empty.tasks]
      for (const botId of new Set<string>(rows.map(row => row.botId).filter(Boolean))) tasks.push(...(await forBot(botId).listForIssue(userId, issueId)).tasks)
      const byId = new Map(tasks.map(task => [task.id, task]))
      return { ...empty, tasks: rows.flatMap(row => byId.has(row.id) ? [byId.get(row.id)!] : []) }
    },
  }
}
