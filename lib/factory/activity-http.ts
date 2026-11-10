import { z } from 'zod'
import type { Pool } from 'pg'
import { FactoryError } from './contract'
import { readFactoryActivity } from './activity'
import type { createFactoryStore } from './store'

/** Uses the same authenticated owner and canonical store as task detail. */
export async function handleFactoryActivity(pool: Pool, store: Pick<ReturnType<typeof createFactoryStore>, 'readTask'>,
  input: { userId: string | null; taskId: string }) {
  if (!input.userId) return { status: 401, body: { error: 'authRequired' } }
  if (!z.uuid().safeParse(input.taskId).success) return { status: 404, body: { error: 'factoryNotFound' } }
  try { return { status: 200, body: await readFactoryActivity(pool, store, input.userId, input.taskId) } }
  catch (error) {
    if (!(error instanceof FactoryError)) throw error
    return { status: error.code === 'factoryNotFound' ? 404 : 409, body: { error: error.code } }
  }
}
