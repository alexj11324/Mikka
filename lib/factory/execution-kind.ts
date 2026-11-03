import type { PoolClient } from 'pg'
import { factoryRunBotMatches } from './run-scope'

/** Host repository and frozen policy determine purpose; a model report cannot select it. */
export function factoryExecutionKind(repo: { remoteUrl?: string | null; repoPath?: string | null } | undefined, readOnly: boolean | undefined) {
  return !repo?.remoteUrl && repo?.repoPath?.startsWith('/home/user/.mikka/bot-workspaces/')
    ? 'deliverable' as const : readOnly ? 'report' as const : 'repository' as const
}

export async function isCurrentFactoryDeliverable(tx: Pick<PoolClient, 'query'>, userId: string, runId: string) {
  const { rows: [row] } = await tx.query(`SELECT repo."remoteUrl",repo."repoPath",r."agentDefinition",r."botId",t."botId" AS "taskBotId"
    FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId" AND repo."deviceId"=r."deviceId"
    WHERE r.id=$1 AND t."userId"=$2 AND t.stage='execute' AND t.status='running' AND a.status='running'`, [runId, userId])
  return !!row && factoryExecutionKind(row, row.agentDefinition?.readOnly) === 'deliverable' &&
    await factoryRunBotMatches(tx, { userId, botId: row.taskBotId }, { id: runId, botId: row.botId })
}
