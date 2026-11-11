import { createFactoryStore } from '../../lib/factory/store'

/** Fixtures for tasks persisted before the host-frozen flowVersion existed.
 * Use the real lifecycle and receipt consumers. Only initial fixture materialization
 * removes the new host marker, including its initial snapshot, before work runs.
 * New flow tests must use createFactoryStore directly. */
export function createLegacyFactoryStore(...args: Parameters<typeof createFactoryStore>): ReturnType<typeof createFactoryStore> {
  const store = createFactoryStore(...args)
  const route = store.route
  store.route = async (...input) => {
    const result = await route(...input)
    const tx = input[2] ?? args[0]
    await tx.query(`UPDATE factory_tasks SET route=route-'flowVersion' WHERE id=$1`, [result.task.id])
    await tx.query(`UPDATE factory_events SET result=jsonb_set(result,'{task,route}',(result#>'{task,route}')-'flowVersion')
      WHERE "taskId"=$1 AND "eventId"=$2`, [result.task.id, result.task.route.eventId])
    delete result.task.route.flowVersion
    return result
  }
  return store
}
