import type { PoolClient } from 'pg'
import { maskCredentials } from './secrets/mask'
import type { DecisionSourceLocator } from './project-map/contracts'

export interface ProjectDecisionWarning {
  code: 'possible_unrecorded_decision'
  severity: 'warning'
  sourceRefs: Pick<DecisionSourceLocator, 'type' | 'id'>[]
  explanation: string
  relatedDecisionIds: string[]
}
type Query = Pick<PoolClient, 'query'>
type Signal = { kind: 'thread_replaced' | 'candidate_replaced_after_rejection'; sourceIds: string[]; recorded: boolean }

/** Only host-recorded state transitions reach this mapper. Text, retries and model failures are not signals. */
export function missingDecisionWarning(signal: Signal): ProjectDecisionWarning[] {
  if (signal.recorded) return []
  return [{
    code: 'possible_unrecorded_decision', severity: 'warning',
    sourceRefs: signal.sourceIds.map(id => ({ type: signal.kind === 'thread_replaced' ? 'run' as const : 'candidate' as const, id })),
    explanation: signal.kind === 'thread_replaced'
      ? 'This completed thread was replaced by another thread for the same task, but no active project decision links either run. Review the change and record its reasons in Mikka.'
      : 'The current candidate differs from the candidate the owner rejected, but no active project decision links the changed candidates. Review the change and record its reasons in Mikka.',
    relatedDecisionIds: [],
  }]
}

/** An explicit output line from the existing independent reviewer, never a keyword match on a user prompt. */
export function reviewDecisionExplanation(summary: unknown): string | null {
  if (typeof summary !== 'string') return null
  const line = /^possible_unrecorded_decision: ([^\r\n]{1,500})$/m.exec(summary)?.[1]?.trim()
  if (!line) return null
  return maskCredentials(line, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[REDACTED]')
    .replace(/\b(password|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
}

const activeRunDecision = `EXISTS(SELECT 1 FROM project_decisions pd
  WHERE pd."recordStatus"='active' AND NOT EXISTS(SELECT 1 FROM project_decisions replacement WHERE replacement."supersedesId"=pd.id)
    AND (pd."runId" IN (r.id, successor.id) OR EXISTS(SELECT 1 FROM project_decision_sources source
      WHERE source."decisionId"=pd.id AND source."sourceType"='run' AND source."sourceId" IN (r.id::text,successor.id::text))))`
const runSignals = `SELECT r.id,successor.id AS "successorId",${activeRunDecision} AS recorded
  FROM agent_runs r JOIN agent_runs successor ON successor.id=r."threadReplacedBy"
    AND successor."userId"=r."userId" AND successor."issueId"=r."issueId"`

/** Called only after the normal owned RunDetail read. The SQL repeats owner/issue binding; it returns no message text. */
export async function runDecisionWarnings(tx: Query, userId: string, runId: string): Promise<ProjectDecisionWarning[]> {
  const { rows } = await tx.query<{ id: string; successorId: string; recorded: boolean }>(
    runSignals + ` WHERE r.id=$1 AND r."userId"=$2 AND r.status IN ('succeeded','failed','stopped','cancelled') LIMIT 1`, [runId, userId])
  return rows.flatMap(row => missingDecisionWarning({ kind: 'thread_replaced', sourceIds: [row.id, row.successorId], recorded: row.recorded }))
}

/** The authenticated Factory read/reconcile supplies its frozen task; no inferred decisions are written here. */
export async function factoryDecisionWarnings(tx: Query, task: { id: string; issueId: string; userId: string }): Promise<ProjectDecisionWarning[]> {
  const { rows: runs } = await tx.query<{ id: string; successorId: string; recorded: boolean }>(
    runSignals + ` JOIN factory_tasks t ON t.id=$1 AND t."userId"=r."userId" AND t."issueId"=r."issueId"
      WHERE r."userId"=$2 AND r."issueId"=$3 AND r.status IN ('succeeded','failed','stopped','cancelled')
        AND EXISTS(SELECT 1 FROM factory_attempts a WHERE a."taskId"=t.id AND a."runId"=r.id)
      ORDER BY r."createdAt" DESC LIMIT 20`, [task.id, task.userId, task.issueId])
  const { rows: candidates } = await tx.query<{ previousId: string; currentId: string; recorded: boolean }>(`
    SELECT DISTINCT previous.id AS "previousId",current.id AS "currentId",
      EXISTS(SELECT 1 FROM project_decisions pd WHERE pd."recordStatus"='active'
        AND NOT EXISTS(SELECT 1 FROM project_decisions replacement WHERE replacement."supersedesId"=pd.id)
        AND (pd."runId" IN (previous."runId",current."runId") OR EXISTS(SELECT 1 FROM project_decision_sources source
          WHERE source."decisionId"=pd.id AND source."sourceType"='candidate' AND source."sourceId" IN (previous.id::text,current.id::text)))) AS recorded
    FROM factory_tasks t
    JOIN factory_approval_controls control ON control."taskId"=t.id AND control."userId"=t."userId" AND control.request->>'operation'='reject'
    JOIN factory_candidates previous ON previous."taskId"=t.id AND previous.id::text=control.request->>'candidateId'
    JOIN factory_candidates current ON current."taskId"=t.id AND current.id=t."candidateId"
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3 AND current.id<>previous.id LIMIT 20`, [task.id, task.userId, task.issueId])
  const { rows: reviews } = await tx.query<{ runId: string; candidateId: string; summary: unknown; recorded: boolean }>(`
    SELECT r.id AS "runId",c.id AS "candidateId",r.report->>'summary' AS summary,
      EXISTS(SELECT 1 FROM project_decisions pd WHERE pd."recordStatus"='active'
        AND NOT EXISTS(SELECT 1 FROM project_decisions replacement WHERE replacement."supersedesId"=pd.id)
        AND (pd."runId" IN (c."runId",r.id) OR EXISTS(SELECT 1 FROM project_decision_sources source
          WHERE source."decisionId"=pd.id AND source."sourceType"='candidate' AND source."sourceId"=c.id::text))) AS recorded
    FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id AND a.stage='review'
    JOIN factory_candidates c ON c."taskId"=t.id AND c.id=a."candidateId"
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3
      AND a.output->'check'->>'candidateId'=c.id::text
      AND r.status IN ('succeeded','failed','stopped','cancelled')
    ORDER BY a.position DESC LIMIT 20`, [task.id, task.userId, task.issueId])
  const semantic = reviews.flatMap(row => {
    const explanation = reviewDecisionExplanation(row.summary)
    return explanation && !row.recorded ? [{
      code: 'possible_unrecorded_decision' as const, severity: 'warning' as const,
      sourceRefs: [{ type: 'run' as const, id: row.runId }, { type: 'candidate' as const, id: row.candidateId }],
      explanation, relatedDecisionIds: [],
    }] : []
  })
  return [
    ...semantic,
    ...runs.flatMap(row => missingDecisionWarning({ kind: 'thread_replaced', sourceIds: [row.id, row.successorId], recorded: row.recorded })),
    ...candidates.flatMap(row => missingDecisionWarning({ kind: 'candidate_replaced_after_rejection', sourceIds: [row.previousId, row.currentId], recorded: row.recorded })),
  ]
}
