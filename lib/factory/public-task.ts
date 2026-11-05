import type { Pool, PoolClient } from 'pg'
import { factoryFlowVersion, type FactoryBinding } from './contract'
import { factoryBinding } from './dispatch'
import { maskFactoryNote } from './note-mask'
import { publicFactoryStage, readFactoryFlow, type FactoryFlowView } from './public-flow'
import type { createFactoryStore, FactoryAttempt, FactoryCandidate, FactoryTask } from './store'

const HISTORY_LIMIT = 20
const text = (value: string, limit = 1000) => maskFactoryNote(value).slice(0, limit)
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const notes = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20).map(item => text(item)) : []

export interface FactoryPublicTaskSummary {
  version: 2
  id: string
  issueId: string
  botId: string | null
  revision: number
  stage: FactoryFlowView['stage']
  needsYou?: FactoryFlowView['needsYou']
  completion?: FactoryFlowView['completion']
  binding: FactoryBinding
  reason: string
  candidateRunId: string | null
  candidateSha: string | null
}

export function publicFactoryTaskSummary(task: FactoryTask, state: Pick<FactoryFlowView, 'stage' | 'needsYou' | 'completion'>,
  candidate: { candidateRunId: string | null; candidateSha: string | null }): FactoryPublicTaskSummary {
  return { version: 2, id: task.id, issueId: task.issueId, botId: task.botId, revision: task.revision, ...state,
    binding: factoryBinding(task), reason: text(task.reason, 4000), candidateRunId: candidate.candidateRunId, candidateSha: candidate.candidateSha }
}

/** Clarification has no run. Preserve the latest unresolved request without exposing the internal route. */
async function clarification(tx: Pick<PoolClient, 'query'>, task: FactoryTask) {
  if (task.stage !== 'clarify') return undefined
  const { rows: [attempt] } = await tx.query('SELECT output FROM factory_attempts WHERE id=$1 AND "taskId"=$2', [task.attemptId, task.id])
  const unresolved = record(record(attempt?.output).unresolved)
  const input = Object.keys(unresolved).length ? unresolved : record(task.route)
  return { missingInformation: notes(input.missingInformation), missingPermissions: notes(input.missingPermissions), needsSpec: input.needsSpec === true }
}

/** Only retained evidence references are public; prompts, transcripts and execution-session identifiers stay private. */
function evidenceReferences(value: unknown) {
  return (Array.isArray(value) ? value : []).slice(0, 20).flatMap(item => {
    const entry = record(item)
    if (typeof entry.artifact !== 'string' || typeof entry.runId !== 'string') return []
    return [{ artifact: text(entry.artifact, 2000), runId: entry.runId,
      ...(typeof entry.kind === 'string' ? { kind: entry.kind } : {}),
      ...(typeof entry.candidateId === 'string' ? { candidateId: entry.candidateId } : {}),
      ...(typeof entry.sha === 'string' ? { sha: entry.sha } : {}),
      ...(typeof entry.recordedAt === 'string' ? { recordedAt: entry.recordedAt } : {}) }]
  })
}

/**
 * Normal Coordinator reads retain the canonical store's owner/Bot/source/issue checks.
 * A v2 view and its operation binding come from the same read snapshot. Internal
 * workers and the legacy browser detail route keep the original store contract.
 */
export async function readFactoryTaskView(pool: Pool, store: Pick<ReturnType<typeof createFactoryStore>, 'readTask' | 'read'>, userId: string, taskId: string) {
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const task = await store.readTask(tx, userId, taskId)
    if (factoryFlowVersion(task) === 2) {
      const flow = await readFactoryFlow(tx, task)
      const { rows } = await tx.query<Pick<FactoryAttempt, 'id' | 'stage' | 'status' | 'candidateId' | 'runId' | 'position' | 'reason' | 'evidence'> & { total: string }>(
        `SELECT id,stage,status,"candidateId","runId",position,reason,evidence,count(*) OVER() AS total
         FROM factory_attempts WHERE "taskId"=$1 AND "runId" IS NOT NULL ORDER BY position DESC LIMIT $2`, [task.id, HISTORY_LIMIT])
      const attempts = rows.reverse().filter(attempt => flow.stages.includes(publicFactoryStage(attempt.stage, 'pending', false)))
        .map(attempt => ({ id: attempt.id, stage: publicFactoryStage(attempt.stage, 'pending', false), status: attempt.status,
          candidateId: attempt.candidateId, runId: attempt.runId, position: attempt.position, reason: text(attempt.reason), evidence: evidenceReferences(attempt.evidence) }))
      const candidateIds = [...new Set([task.candidateId, ...attempts.map(attempt => attempt.candidateId)].filter((id): id is string => id !== null))]
      const { rows: candidates } = await tx.query<FactoryCandidate>(`SELECT id,"taskId",sha,kind,repository,environment,scope,"runId" FROM factory_candidates
        WHERE "taskId"=$1 AND id=ANY($2::uuid[]) ORDER BY "createdAt",id LIMIT $3`, [task.id, candidateIds, HISTORY_LIMIT + 1])
      const pending = await clarification(tx, task)
      const result = { contractVersion: 2 as const, task: flow, binding: factoryBinding(task), sourceEventId: task.sourceEventId,
        reason: text(task.reason, 4000), ...(pending ? { clarification: pending } : {}), attempts,
        candidates: candidates.map(candidate => ({ id: candidate.id, sha: candidate.sha, kind: candidate.kind,
          repository: text(candidate.repository), environment: text(candidate.environment), scope: text(candidate.scope), runId: candidate.runId })),
        history: { limit: HISTORY_LIMIT, total: Number(rows[0]?.total ?? 0), truncated: Number(rows[0]?.total ?? 0) > HISTORY_LIMIT } }
      await tx.query('COMMIT')
      return result
    }
    await tx.query('COMMIT')
  } catch (error) {
    await tx.query('ROLLBACK')
    throw error
  } finally { tx.release() }
  // Release the probe first: legacy reads own their transaction, including on a one-connection pool.
  return store.read(userId, taskId)
}
