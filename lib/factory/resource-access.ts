import type { PoolClient } from 'pg'

/** Factory receipts contain derived execution output. A Task grant alone must
 * never open a private attempt, candidate or its retained copy in a receipt. */
type Task = { id: string; userId: string; issueId: string; workspaceId?: string | null }

export async function factoryContentReadable(query: Pick<PoolClient, 'query'>, task: Task, viewerId: string): Promise<boolean> {
  if (viewerId === task.userId) return true
  if (!task.workspaceId) return false
  const { rows: [access] } = await query.query<{ allowed: boolean }>(`SELECT
    mikka_resource_acl_allowed('account',$1,$2::uuid,'task',$3::uuid,'canReadContent')
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT "runId" FROM factory_attempts WHERE "taskId"=$4 AND "runId" IS NOT NULL
        UNION SELECT "runId" FROM factory_candidates WHERE "taskId"=$4
      ) source LEFT JOIN agent_runs r ON r.id=source."runId"
      WHERE r.id IS NULL OR r."userId"<>$5 OR r."issueId" IS DISTINCT FROM $3::uuid
        OR r."workspaceId" IS DISTINCT FROM $2::uuid
        OR NOT mikka_resource_acl_allowed('account',$1,$2::uuid,'thread',r.id,'canReadContent')
    ) AS allowed`, [viewerId, task.workspaceId, task.issueId, task.id, task.userId])
  return access?.allowed === true
}

/** Bounded collection read, without one policy round trip per Factory task. */
export async function factoryReadableTasks(query: Pick<PoolClient, 'query'>, tasks: readonly Task[], viewerId: string): Promise<Set<string>> {
  const readable = new Set(tasks.filter(task => task.userId === viewerId).map(task => task.id))
  const shared = tasks.filter(task => task.userId !== viewerId && task.workspaceId).map(task => task.id)
  if (!shared.length) return readable
  const { rows } = await query.query<{ id: string }>(`SELECT t.id FROM factory_tasks t WHERE t.id=ANY($1::uuid[])
    AND mikka_resource_acl_allowed('account',$2,t."workspaceId",'task',t."issueId",'canReadContent')
    AND NOT EXISTS (
      SELECT 1 FROM (
        SELECT "runId" FROM factory_attempts WHERE "taskId"=t.id AND "runId" IS NOT NULL
        UNION SELECT "runId" FROM factory_candidates WHERE "taskId"=t.id
      ) source LEFT JOIN agent_runs r ON r.id=source."runId"
      WHERE r.id IS NULL OR r."userId"<>t."userId" OR r."issueId" IS DISTINCT FROM t."issueId"
        OR r."workspaceId" IS DISTINCT FROM t."workspaceId"
        OR NOT mikka_resource_acl_allowed('account',$2,t."workspaceId",'thread',r.id,'canReadContent')
    )`, [shared, viewerId])
  for (const row of rows) readable.add(row.id)
  return readable
}
