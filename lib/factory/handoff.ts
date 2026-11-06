import { createHash } from 'node:crypto'
import { deploymentSwitch } from '../deployment-switches'
import { types, type Pool, type PoolClient, type QueryResultRow } from 'pg'
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

function restoreDateColumns(rows: QueryResultRow[], fields: string[]) {
  const parse = types.getTypeParser(types.builtins.TIMESTAMPTZ)
  for (const row of rows) for (const field of fields) {
    if (typeof row[field] === 'string') row[field] = parse(row[field])
  }
}

function decodeRows(rows: unknown[][], fields: string[]): QueryResultRow[] {
  return rows.map(row => Object.fromEntries(fields.map((field, index) => [field, row[index]])))
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
  // One snapshot/round trip for the same bounded observations. Compact row
  // arrays avoid repeating column names in every history entry; decode them in
  // the original SELECT order to preserve the digest. Timestamp text goes
  // through pg's original parser; nested receipt JSON stays untouched.
  const { rows: [history] } = await tx.query<{
    source: unknown[] | null; attempts: unknown[][]; effects: unknown[][];
    publications: unknown[][]; operations: unknown[][]; dependencies: unknown[][];
  }>(`SELECT
    (SELECT json_build_array(e.id,e."createdAt"::text,e.payload->>'text',i.title,i.content)
      FROM coordinator_events e JOIN issues i ON i.id=$3 WHERE e.id=$4 AND e."userId"=$2
    ) AS source,
    (SELECT COALESCE(json_agg(a.entry),'[]'::json) FROM (
      SELECT json_build_array(a.id,a.stage,a.status,a."runId",a.reason,a."candidateId",a.output->>'requestEpoch',
        a."finishedAt"::text,r.status,r."stopReason",r.error,r."deviceId",r."sessionId",
        c.sha,c.repository,c.environment,c."createdAt"::text,
        cp."baseCommit",cp."updatedAt"::text,cp.files,cp."unavailableReason") AS entry
      FROM factory_attempts a LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$2 AND r."issueId"=$3
      LEFT JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
      LEFT JOIN run_checkpoints cp ON cp."runId"=r.id AND cp."userId"=$2
      WHERE a."taskId"=$1 ORDER BY a.position DESC LIMIT 20
    ) a) AS attempts,
    (SELECT COALESCE(json_agg(e.entry),'[]'::json) FROM (
      SELECT json_build_array(id,status,action,target,receipt,"candidateId","finishedAt"::text) AS entry
      FROM factory_publications WHERE "taskId"=$1 ORDER BY (status IN ('reserved','uncertain')) DESC,"createdAt" DESC LIMIT 20
    ) e) AS effects,
    (SELECT COALESCE(json_agg(p.entry),'[]'::json) FROM (
      SELECT json_build_array(p."runId",p.status,p."remoteKey",p.branch,p."pullRequest",p."errorCode",p."updatedAt"::text) AS entry
      FROM run_publications p WHERE p."userId"=$2 AND p."issueId"=$3
        AND EXISTS(SELECT 1 FROM factory_attempts a WHERE a."taskId"=$1 AND a."runId"=p."runId")
      ORDER BY (p.status='processing') DESC,p."updatedAt" DESC LIMIT 20
    ) p) AS publications,
    (SELECT COALESCE(json_agg(o.entry),'[]'::json) FROM (
      SELECT json_build_array(o."operationId",o.status,o."runId",o.binding->>'action',
        o.binding->>'target',o.receipt,o."updatedAt"::text) AS entry FROM operation_ledger o WHERE o."ownerId"=$2
        AND EXISTS(SELECT 1 FROM factory_attempts a WHERE a."taskId"=$1
          AND (a."runId"=o."runId" OR a."runId"::text=o.binding->>'executionRunId'))
      ORDER BY (o.status IN ('executing','uncertain')) DESC,o."updatedAt" DESC LIMIT 20
    ) o) AS operations,
    (SELECT COALESCE(json_agg(q.entry),'[]'::json) FROM (
      SELECT json_build_array(id,status,"originRunId",kind) AS entry FROM factory_questions
      WHERE "taskId"=$1 AND "userId"=$2 AND status NOT IN ('resolved','cancelled','expired','superseded') ORDER BY "createdAt" DESC LIMIT 10
    ) q) AS dependencies`, [task.id, task.userId, task.issueId, task.sourceEventId])
  const [source] = decodeRows(history.source ? [history.source] : [], ['id', 'createdAt', 'text', 'title', 'content'])
  const attempts = decodeRows(history.attempts, ['id', 'stage', 'status', 'runId', 'reason', 'candidateId', 'requestEpoch', 'finishedAt',
    'runStatus', 'stopReason', 'error', 'deviceId', 'sessionId', 'sha', 'repository', 'environment', 'candidateCreatedAt',
    'checkpointCommit', 'checkpointAt', 'checkpointFiles', 'unavailableReason'])
  const effects = decodeRows(history.effects, ['id', 'status', 'action', 'target', 'receipt', 'candidateId', 'finishedAt'])
  const publications = decodeRows(history.publications, ['runId', 'status', 'remoteKey', 'branch', 'pullRequest', 'errorCode', 'updatedAt'])
  const operations = decodeRows(history.operations, ['operationId', 'status', 'runId', 'action', 'target', 'receipt', 'updatedAt'])
  const dependencies = decodeRows(history.dependencies, ['id', 'status', 'originRunId', 'kind'])
  restoreDateColumns(source ? [source] : [], ['createdAt'])
  restoreDateColumns(attempts, ['finishedAt', 'candidateCreatedAt', 'checkpointAt'])
  restoreDateColumns(effects, ['finishedAt'])
  restoreDateColumns(publications, ['updatedAt'])
  restoreDateColumns(operations, ['updatedAt'])
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
}
