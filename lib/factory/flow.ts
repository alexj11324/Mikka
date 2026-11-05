import type { PoolClient } from 'pg'
import { factoryFlowVersion, nextStage } from './contract'
import type { FactoryTask } from './store'

/** The task lock serializes this read with every review/repair transition.
 * A question continuation remains the same review; an unstarted pending check
 * does not consume it. History is task-wide, even after a new owner request. */
export async function factoryReviewPerformed(tx: Pick<PoolClient, 'query'>, task: Pick<FactoryTask, 'id'>): Promise<boolean> {
  const { rows: [row] } = await tx.query(`SELECT EXISTS(SELECT 1 FROM factory_attempts
    WHERE "taskId"=$1 AND stage='review' AND "runId" IS NOT NULL
      AND status IN ('passed','failed','blocked','waiting')) AS reviewed`, [task.id])
  return row?.reviewed === true
}

export async function factoryNextStage(tx: Pick<PoolClient, 'query'>, task: Pick<FactoryTask, 'id' | 'stage' | 'route'>) {
  const version = factoryFlowVersion(task)
  const reviewed = version === 2 && task.stage === 'execute' && await factoryReviewPerformed(tx, task)
  return nextStage(task.stage, version, reviewed)
}
