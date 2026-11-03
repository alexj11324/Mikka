import { z } from 'zod'
import type { Pool, PoolClient } from 'pg'
import { FactoryError } from './contract'
import { createFactoryStore, type FactoryAuthorize, type FactoryGates } from './store'

/** Browser sessions select an owned task by id, across their Bots. Each
 * operation still uses the task's real Bot/source/issue authorization fence. */
export function createFactoryBrowserStore(pool: Pool, authorize: FactoryAuthorize, gates: FactoryGates) {
  const root = createFactoryStore(pool,authorize,gates)
  const forTask = async (userId: string, taskId: string, tx?: PoolClient) => {
    if (!z.uuid().safeParse(taskId).success) throw new FactoryError('factoryInvalid')
    const row = (await (tx ?? pool).query('SELECT "botId" FROM factory_tasks WHERE id=$1 AND "userId"=$2',[taskId,userId])).rows[0]
    if (!row) throw new FactoryError('factoryNotFound')
    return createFactoryStore(pool,authorize,row.botId,{gates,independent:(await import('./check-independence')).factoryCheckIndependent})
  }
  return {
    ...root,
    lockTask: async (tx: PoolClient,userId: string,taskId: string) => (await forTask(userId,taskId,tx)).lockTask(tx,userId,taskId),
    readTask: async (tx: PoolClient,userId: string,taskId: string) => (await forTask(userId,taskId,tx)).readTask(tx,userId,taskId),
    read: async (userId: string,taskId: string) => (await forTask(userId,taskId)).read(userId,taskId),
    apply: async (...args: Parameters<typeof root.apply>) => (await forTask(args[0],args[1].taskId,args[4])).apply(...args),
    listForIssue: async (userId: string,issueId: string) => {
      const initial = await root.listForIssue(userId,issueId)
      const { rows } = await pool.query('SELECT "botId",id FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2 ORDER BY "updatedAt" DESC,id DESC LIMIT 50',[userId,issueId])
      const summaries = [...initial.tasks]
      for (const botId of new Set(rows.map(row=>row.botId).filter(Boolean))) summaries.push(...(await createFactoryStore(pool,authorize,botId).listForIssue(userId,issueId)).tasks)
      const byId = new Map(summaries.map(task=>[task.id,task]))
      return {...initial,tasks:rows.flatMap(row=>byId.has(row.id) ? [byId.get(row.id)!] : [])}
    },
  }
}
