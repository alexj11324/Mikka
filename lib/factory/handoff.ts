import { createHash } from 'node:crypto'
import { deploymentSwitch } from '../deployment-switches'
import type { Pool, PoolClient } from 'pg'
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

/** A handoff is a reproducible host observation, never acceptance or authority.
 * No checkpoint bytes, secrets or native session state are copied into it. */
export async function persistFactoryHandoff(tx: Pick<PoolClient, 'query'>, task: FactoryTask) {
  const { rows: [source] } = await tx.query(`SELECT e.id,e."createdAt",e.payload->>'text' AS text,i.title,i.content
    FROM coordinator_events e JOIN issues i ON i.id=$3 WHERE e.id=$1 AND e."userId"=$2`, [task.sourceEventId, task.userId, task.issueId])
  const { rows: attempts } = await tx.query(`SELECT a.id,a.stage,a.status,a."runId",a.reason,a."candidateId",a.output->>'requestEpoch' AS "requestEpoch",
    a."finishedAt",r.status AS "runStatus",r."stopReason",r.error,r."deviceId",r."sessionId",
    c.sha,c.repository,c.environment,c."createdAt" AS "candidateCreatedAt",
    cp."baseCommit" AS "checkpointCommit",cp."updatedAt" AS "checkpointAt",cp.files AS "checkpointFiles",cp."unavailableReason"
    FROM factory_attempts a LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$2 AND r."issueId"=$3
    LEFT JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
    LEFT JOIN run_checkpoints cp ON cp."runId"=r.id AND cp."userId"=$2
    WHERE a."taskId"=$1 ORDER BY a.position DESC LIMIT 20`, [task.id, task.userId, task.issueId])
  const { rows: effects } = await tx.query(`SELECT id,status,action,target,receipt,"candidateId","finishedAt"
    FROM factory_publications WHERE "taskId"=$1 ORDER BY "createdAt" DESC LIMIT 20`, [task.id])
  const { rows: publications } = await tx.query(`SELECT p."runId",p.status,p."remoteKey",p.branch,p."pullRequest",p."errorCode",p."updatedAt"
    FROM run_publications p WHERE p."userId"=$2 AND p."issueId"=$3
      AND EXISTS(SELECT 1 FROM factory_attempts a WHERE a."taskId"=$1 AND a."runId"=p."runId")
    ORDER BY p."updatedAt" DESC LIMIT 20`, [task.id, task.userId, task.issueId])
  const { rows: operations } = await tx.query(`SELECT o."operationId",o.status,o."runId",o.binding->>'action' AS action,
    o.binding->>'target' AS target,o.receipt,o."updatedAt" FROM operation_ledger o WHERE o."ownerId"=$2
      AND EXISTS(SELECT 1 FROM factory_attempts a WHERE a."taskId"=$1
        AND (a."runId"=o."runId" OR a."runId"::text=o.binding->>'executionRunId')) ORDER BY o."updatedAt" DESC LIMIT 20`, [task.id, task.userId])
  const { rows: dependencies } = await tx.query(`SELECT id,status,"originRunId",kind FROM factory_questions
    WHERE "taskId"=$1 AND "userId"=$2 AND status NOT IN ('resolved','cancelled','expired','superseded') ORDER BY "createdAt" DESC LIMIT 10`, [task.id, task.userId])
  const latest = attempts.find(a => a.runId)
  const artifact = attempts.find(a => a.sha)
  const checkpoint = attempts.find(a => a.checkpointAt)
  const handoff = {
    version: 1, taskId: task.id, issueId: task.issueId, botId: task.botId, ownerId: task.userId,
    requestEpoch: task.sourceEventId, revision: task.revision, attemptId: task.attemptId,
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
export async function factoryRecoveryHandoff(pool: Pool, run: { id: string; userId: string }, prompt: string): Promise<{ prompt: string; briefing: string; blocked?: string }> {
  if (!deploymentSwitch('factoryRouting') || !deploymentSwitch('factoryLifecycle')) return { prompt, briefing: '' }
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    const { factoryClaimTask } = await import('./claim')
    const identity = await factoryClaimTask(tx, run.id)
    if (!identity) { await tx.query('COMMIT'); return { prompt, briefing: '' } }
    const { factoryRuntimeForBot } = await import('./runtime')
    const task = await factoryRuntimeForBot(identity.botId).store.lockTask(tx, run.userId, identity.id)
    const handoff = await persistFactoryHandoff(tx, task)
    const effects = handoff.externalEffects
    const uncertain = effects.effects.some(e => ['reserved', 'uncertain'].includes(e.status))
      || effects.operations.some(o => ['executing', 'uncertain'].includes(o.status))
      || effects.publications.some(p => p.status === 'processing')
    const currentRequest = await (await import('./checks')).currentFactoryRequest(tx, task)
    const suffix = factoryHandoffPrompt(handoff)
    await tx.query('COMMIT')
    return { prompt: currentRequest + prompt.slice(0, 100000 - currentRequest.length - suffix.length) + suffix, briefing: currentRequest + suffix,
      ...(uncertain ? { blocked: 'An external action may already have happened. Reconcile its existing receipt before resuming on another machine.' } : {}) }
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
}
