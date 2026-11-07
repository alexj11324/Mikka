import { pool } from '@/lib/db'
import { createFactoryDispatchRecovery } from './dispatch-recovery'
import { factoryHumanStore } from './server'

const recovery = createFactoryDispatchRecovery(pool)

/** Status and recovery controls must pass the same current-tenant task gate
 * as detail reads before the legacy device projection is evaluated. */
export const factoryDispatchRecovery = {
  ...recovery,
  status: async (userId: string, taskId: string) => {
    await factoryHumanStore.read(userId, taskId)
    return recovery.status(userId, taskId)
  },
  switchToCloud: async (userId: string, taskId: string) => {
    await factoryHumanStore.read(userId, taskId)
    return recovery.switchToCloud(userId, taskId)
  },
}
