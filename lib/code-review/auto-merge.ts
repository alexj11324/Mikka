import 'server-only'
import type { PoolClient } from 'pg'
import type { RunReport } from '@mikka/protocol/run'
import type { FactoryTask } from '@/lib/factory/store'
import { FactoryError } from '@/lib/factory/contract'
import { approvalEvidence, factoryHandoffEvidenceError } from '@/lib/factory/evidence'
import { publicationDefaults } from './settings-storage'

type AutoMergeInput = {
  userId: string; workspaceId: string | null; issueId: string; runId: string; commit: string
  preferred: boolean; draft: boolean; verification: RunReport['verify']['status']
}

/** Read under the publication's task/run locks. A saved preference is never review evidence. */
export async function automaticMergeReadiness(tx: PoolClient, input: AutoMergeInput): Promise<'ready' | 'waiting' | 'ineligible'> {
  if (!input.preferred || input.draft || input.verification !== 'passed' || !input.workspaceId) return 'ineligible'
  const { rows: [owner] } = await tx.query('SELECT 1 FROM issues WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3 AND "ownershipState"=\'bound\'', [input.issueId, input.userId, input.workspaceId])
  if (!owner || !(await publicationDefaults(input)).autoMerge) return 'ineligible'
  const { rows } = await tx.query<FactoryTask & { sha: string | null; candidateRunId: string | null }>(`SELECT t.*,c.sha,c."runId" AS "candidateRunId" FROM factory_tasks t
    JOIN factory_attempts a ON a."taskId"=t.id AND a."runId"=$1 AND a.stage='execute'
    LEFT JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
    WHERE t."userId"=$2 AND t."issueId"=$3 FOR SHARE OF t`, [input.runId, input.userId, input.issueId])
  if (!rows.length) return 'ready'
  if (rows.length !== 1) return 'ineligible'
  const task = rows[0]
  if (['execute', 'review', 'verify'].includes(task.stage) && ['pending', 'running'].includes(task.status)) return 'waiting'
  if (task.stage !== 'approval' || !['pending', 'waiting'].includes(task.status) || task.sha !== input.commit || task.candidateRunId !== input.runId) return 'ineligible'
  // A prior review of a repaired candidate is useful history, not approval
  // of this HEAD for an unattended merge.
  const { rows: [review] } = await tx.query(`SELECT status FROM factory_attempts WHERE "taskId"=$1 AND "candidateId"=$2 AND stage='review' ORDER BY position DESC LIMIT 1`, [task.id, task.candidateId])
  if (review?.status !== 'passed') return 'ineligible'
  try {
    await approvalEvidence(tx, task)
    if (await factoryHandoffEvidenceError(tx, task)) return 'ineligible'
  } catch (error) {
    if (!(error instanceof FactoryError)) throw error
    return 'ineligible'
  }
  return 'ready'
}
