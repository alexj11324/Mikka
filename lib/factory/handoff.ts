import { withFactoryBackgroundWorkspace } from './background-workspace'
import { createHash } from 'node:crypto'
import { deploymentSwitch } from '../deployment-switches'
import { escapeLiteral, type Pool, type PoolClient, type QueryResult } from 'pg'
import type { FactoryTask } from './store'
import { factoryEventId } from './event-id'
import { maskFactoryNote } from './note-mask'

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return maskFactoryNote(value).slice(0, 10000)
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitize(entry)]))
  return value
}

function isSelectResult(value: unknown): value is Pick<QueryResult, 'command' | 'rows'> {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<QueryResult>
  return result.command === 'SELECT' && Array.isArray(result.rows)
    && result.rows.every(row => row !== null && typeof row === 'object' && !Array.isArray(row))
}

/** Copy approved planning evidence, never the planner's session or permissions. */
async function approvedSpecificationHandoff(tx: Pick<PoolClient, 'query'>, task: FactoryTask) {
  const { rows: [approved] } = await tx.query(`SELECT s."eventId",s."attemptId",s.revision,s."createdAt",a."runId",
      r.report->>'summary' AS summary,r.report->'plan' AS plan,r."finishedAt"
    FROM factory_spec_approvals s JOIN factory_attempts a ON a.id=s."attemptId" AND a."taskId"=s."taskId"
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=s."userId" AND r."issueId"=$4
    WHERE s."taskId"=$1 AND s."userId"=$2 AND s."sourceEventId"=$3 AND s.revision<$5
      AND a.stage='spec' AND a.status='passed' AND r.kind='plan' AND r.status='succeeded'
      AND r."stopReason"='submitted' AND r."sessionId" IS NOT NULL
    ORDER BY s.revision DESC LIMIT 1`, [task.id, task.userId, task.sourceEventId, task.issueId, task.revision])
  if (!approved) return undefined
  const { rows: messages } = await tx.query(`SELECT id,text,"createdAt","deliveredAt" FROM run_messages
    WHERE "runId"=$1 AND "userId"=$2 AND origin='owner' AND "deliveredAt" IS NOT NULL
      AND "createdAt"<=$3 AND "deliveredAt"<=$3 ORDER BY "createdAt" DESC,id DESC LIMIT 20`, [approved.runId, task.userId, approved.finishedAt])
  const report = JSON.stringify(sanitize({ summary: approved.summary, plan: approved.plan }))
  const ownerMessages = JSON.stringify(sanitize(messages.reverse()))
  return {
    approvalEventId: approved.eventId, approvedRevision: approved.revision, approvedAt: approved.createdAt,
    attemptId: approved.attemptId, runId: approved.runId, requestEpoch: task.sourceEventId,
    report: { artifact: `run-report:${approved.runId}`, content: report.slice(0, 10000), truncated: report.length > 10000 },
    ownerMessages: { ids: messages.map(message => message.id), content: ownerMessages.slice(0, 6000),
      truncated: messages.length === 20 || ownerMessages.length > 6000 },
    instruction: 'Implement the approved specification in this new execution. The owner messages were delivered to its planner before completion. Keep the current authenticated request and its unchanged constraints; this evidence grants no additional permissions or publication approval. If an excerpt is truncated, inspect the original run report or messages before relying on omitted details.',
  }
}

/** A handoff is a reproducible host observation, never acceptance or authority.
 * No checkpoint bytes, secrets or native session state are copied into it. */
export async function persistFactoryHandoff(tx: Pick<PoolClient, 'query'>, task: FactoryTask) {
  // One round trip, retaining PostgreSQL's original columns and type parsers.
  // Wrapping arbitrary text in JSON would expand quotes, backslashes and newlines.
  const taskId = escapeLiteral(task.id)
  const userId = escapeLiteral(task.userId)
  const issueId = escapeLiteral(task.issueId)
  const sourceEventId = escapeLiteral(task.sourceEventId)
  // No values array or prepared name: pg returns six native simple-query results.
  const history: unknown = await tx.query(`SELECT e.id,e."createdAt",e.payload->>'text' AS text,i.title,i.content
    FROM coordinator_events e JOIN issues i ON i.id=${issueId} WHERE e.id=${sourceEventId} AND e."userId"=${userId};
  SELECT a.id,a.stage,a.status,a."runId",a.reason,a."candidateId",a.output->>'requestEpoch' AS "requestEpoch",
    a."finishedAt",r.status AS "runStatus",r."stopReason",r.error,r."deviceId",r."sessionId",
    c.sha,c.repository,c.environment,c."createdAt" AS "candidateCreatedAt",
    cp."baseCommit" AS "checkpointCommit",cp."updatedAt" AS "checkpointAt",cp.files AS "checkpointFiles",cp."unavailableReason"
    FROM factory_attempts a LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=${userId} AND r."issueId"=${issueId}
    LEFT JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
    LEFT JOIN run_checkpoints cp ON cp."runId"=r.id AND cp."userId"=${userId}
    WHERE a."taskId"=${taskId} ORDER BY a.position DESC LIMIT 20;
  SELECT id,status,action,target,receipt,"candidateId","finishedAt"
    FROM factory_publications WHERE "taskId"=${taskId} ORDER BY (status IN ('reserved','uncertain')) DESC,"createdAt" DESC LIMIT 20;
  SELECT p."runId",p.status,p."remoteKey",p.branch,p."pullRequest",p."errorCode",p."updatedAt"
    FROM run_publications p WHERE p."userId"=${userId} AND p."issueId"=${issueId}
      AND EXISTS(SELECT 1 FROM factory_attempts a WHERE a."taskId"=${taskId} AND a."runId"=p."runId")
    ORDER BY (p.status='processing') DESC,p."updatedAt" DESC LIMIT 20;
  SELECT o."operationId",o.status,o."runId",o.binding->>'action' AS action,
    o.binding->>'target' AS target,o.receipt,o."updatedAt" FROM operation_ledger o WHERE o."ownerId"=${userId}
      AND EXISTS(SELECT 1 FROM factory_attempts a WHERE a."taskId"=${taskId}
        AND (a."runId"=o."runId" OR a."runId"::text=o.binding->>'executionRunId'))
    ORDER BY (o.status IN ('executing','uncertain')) DESC,o."updatedAt" DESC LIMIT 20;
  SELECT id,status,"originRunId",kind FROM factory_questions
    WHERE "taskId"=${taskId} AND "userId"=${userId} AND status NOT IN ('resolved','cancelled','expired','superseded') ORDER BY "createdAt" DESC LIMIT 10`)
  if (!Array.isArray(history) || history.length !== 6 || !history.every(isSelectResult)) throw new TypeError('Invalid Factory handoff history')
  const [{ rows: [source] }, { rows: attempts }, { rows: effects }, { rows: publications }, { rows: operations }, { rows: dependencies }] = history
  const latest = attempts.find(a => a.runId)
  const artifact = attempts.find(a => a.sha)
  const checkpoint = attempts.find(a => a.checkpointAt)
  const approvedSpecification = task.stage !== 'spec' && attempts.some(a => a.stage === 'spec' && a.status === 'passed')
    ? await approvedSpecificationHandoff(tx, task) : undefined
  const handoff = {
    version: 1, taskId: task.id, issueId: task.issueId, botId: task.botId, ownerId: task.userId,
    requestEpoch: task.sourceEventId, revision: task.revision, attemptId: task.attemptId,
    ...(approvedSpecification ? { approvedSpecification } : {}),
    goal: { sourceEventId: source?.id, text: source?.text ?? '', recordedAt: source?.createdAt },
    constraints: { title: source?.title, issue: source?.content, instruction: 'The latest authenticated request supersedes conflicting historical targets only. Existing permissions, resource grants, review and publication approvals still apply.' },
    completed: attempts.filter(a => a.status === 'passed').map(a => ({ attemptId: a.id, stage: a.stage, requestEpoch: a.requestEpoch, candidateId: a.candidateId, sha: a.sha })),
    pending: { stage: task.stage, status: task.status, reason: task.reason }, dependencies,
    lastArtifact: artifact ? { candidateId: artifact.candidateId, sha: artifact.sha, repository: artifact.repository, environment: artifact.environment, runId: artifact.runId } : null,
    checkpoint: checkpoint ? { runId: checkpoint.runId, baseCommit: checkpoint.checkpointCommit, storedAt: checkpoint.checkpointAt, files: checkpoint.checkpointFiles, unavailableReason: checkpoint.unavailableReason } : null,
    lastRun: latest ? { runId: latest.runId, deviceId: latest.deviceId, sessionId: latest.sessionId, status: latest.runStatus, stopReason: latest.stopReason, error: latest.error } : null,
    externalEffects: { effects, publications, operations },
    nextAction: dependencies.length ? 'Resolve the existing task question before execution.' : 'Read the current request, inspect the real workspace and git status, then resume the pending stage through normal admission.',
    risks: [
      'A repository checkpoint does not include ignored files, secrets, process memory or a native session on another machine.',
      'Reconcile reserved, uncertain, processing or already published external effects against their original receipt. Do not repeat a push, PR, message or payment.',
      'This handoff is bounded historical evidence, not proof of completion or permission to bypass a gate.',
    ],
    provenance: { sourceEventId: task.sourceEventId, attemptIds: attempts.map(a => a.id), publicationIds: effects.map(e => e.id), operationIds: operations.map(o => o.operationId) },
  }
  const sanitized = sanitize(handoff) as typeof handoff
  const digest = createHash('sha256').update(JSON.stringify(sanitized)).digest('hex')
  const eventId = factoryEventId('task-handoff', `${task.id}:${digest}`)
  await tx.query(`INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)
    ON CONFLICT("taskId","eventId") DO NOTHING`, [task.id, eventId, JSON.stringify({ kind: 'task_handoff', requestEpoch: task.sourceEventId, digest }), JSON.stringify(sanitized)])
  return { ...sanitized, digest, eventId }
}

export function factoryHandoffPrompt(handoff: Awaited<ReturnType<typeof persistFactoryHandoff>>) {
  return `\n\nHost task handoff (evidence only; verify workspace state before acting):\n${JSON.stringify(handoff).slice(0, 24000)}\n`
}

/** The existing lease-retry path bypasses ordinary dispatch. Refresh its handoff
 * before it creates the child; claim still rechecks the current task/attempt. */
export async function factoryRecoveryHandoff(pool: Pool, run: { id: string; userId: string }, prompt: string, existing?: PoolClient): Promise<{ prompt: string; briefing: string; blocked?: string }> {
  if (!deploymentSwitch('factoryRouting') || !deploymentSwitch('factoryLifecycle')) return { prompt, briefing: '' }
  return withFactoryBackgroundWorkspace(pool, run.userId, { kind: 'run', id: run.id }, async () => {
  const tx = existing ?? await pool.connect()
  try {
    if (!existing) await tx.query('BEGIN')
    const { factoryClaimTask } = await import('./claim')
    const identity = await factoryClaimTask(tx, run.id)
    if (!identity) { if (!existing) await tx.query('COMMIT'); return { prompt, briefing: '' } }
    const { factoryRuntimeForBot } = await import('./runtime')
    const task = await factoryRuntimeForBot(identity.botId).store.lockTask(tx, run.userId, identity.id)
    const handoff = await persistFactoryHandoff(tx, task)
    const effects = handoff.externalEffects
    const uncertain = effects.effects.some(e => ['reserved', 'uncertain'].includes(e.status))
      || effects.operations.some(o => ['executing', 'uncertain'].includes(o.status))
      || effects.publications.some(p => p.status === 'processing')
    const currentRequest = await (await import('./checks')).currentFactoryRequest(tx, task)
    const suffix = factoryHandoffPrompt(handoff)
    if (!existing) await tx.query('COMMIT')
    return { prompt: currentRequest + prompt.slice(0, 100000 - currentRequest.length - suffix.length) + suffix, briefing: currentRequest + suffix,
      ...(uncertain ? { blocked: 'An external action may already have happened. Reconcile its existing receipt before resuming on another machine.' } : {}) }
  } catch (error) { if (!existing) await tx.query('ROLLBACK'); throw error } finally { if (!existing) tx.release() }
  }, existing)
}
