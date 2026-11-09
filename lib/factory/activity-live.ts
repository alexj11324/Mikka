import { afterDatabaseCommit } from '../db/commit-effects'
import { factoryCommitted } from '../live/factory'
import { scheduleLive } from '../live/notify'
import { liveGatewayConfig } from '../live/scope'

/** VM intervals and ready media change independently of the Factory stage.
 * Resolve their owning tasks only after COMMIT, on the writer's retained DB
 * scope; the existing Factory sender rechecks the canonical workspace. */
export function taskActivityChanged(executor: object, runId: string) {
  if (!liveGatewayConfig(process.env)) return
  afterDatabaseCommit(executor, `factory_activity:${runId}`, () => scheduleLive(async () => {
    const { pool, withoutDatabaseClient } = await import('../db/request-scope')
    await withoutDatabaseClient(async () => {
      const { rows } = await pool.query<{ id: string }>(`SELECT DISTINCT t.id
        FROM agent_runs r JOIN factory_attempts a ON a."runId"=r.id
        JOIN factory_tasks t ON t.id=a."taskId" AND t."userId"=r."userId" AND t."issueId"=r."issueId"
        WHERE r.id=$1`, [runId])
      for (const task of rows) await factoryCommitted(task.id)
    })
  }))
}
