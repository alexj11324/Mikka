import type { Pool, PoolClient } from 'pg'
import { actingContext } from '../activity-actor'
import { readFactoryComputerSessions } from '../cloud-computer/thread-machine-sessions'
import { withDatabaseClient } from '../db/request-scope'
import { tokenWorkspace } from '../tokens/principal'
import { runsOutsideToken } from '../tokens/scope'
import { projectFactoryAttempts, type FactoryAttemptViewSource, type FactoryAttemptTransitionSource } from './attempt-view'
import { readFactoryTaskMedia } from './task-media'
import { readFactoryActivityDocuments } from './activity-artifacts'
import { maskFactoryNote } from './note-mask'
import { readFactoryFlow, type FactoryNeedsYou } from './public-flow'
import type { createFactoryStore, FactoryTask } from './store'

type Instant = Date | string | null
const iso = (value: Instant | undefined) => value == null ? null : new Date(value).toISOString()
const text = (value: string | null, limit = 200) => value == null ? null : maskFactoryNote(value).slice(0, limit)
const githubPullRequest = (value: unknown): string | null => typeof value === 'string'
  && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(value) ? value : null

interface AttemptRow extends FactoryAttemptViewSource {
  /** Original binding stays private; a failed run join is not an unbound control stage. */
  boundRunId: string | null
  candidateId: string | null; status: string; createdAt: Instant; finishedAt: Instant
  runStatus: string | null; runCreatedAt: Instant; startedAt: Instant; runFinishedAt: Instant
  agentId: string | null; agentName: string | null; harness: string | null; model: string | null
  deviceId: string | null; deviceName: string | null; deviceKind: string | null
}
interface TransitionRow extends FactoryAttemptTransitionSource {
  id: string; createdAt: Instant; stage: FactoryTask['stage'] | null; status: FactoryTask['status'] | null
  revision: number | null; taskId: string | null
}
export interface FactoryActivityWait {
  id: string; kind: FactoryNeedsYou['kind']; attemptId: string | null; runId: string | null
  startedAt: string; endedAt: string | null; durationMs: number
}
type PlanReference = { artifactId: string; version: number; url: string }

function attention(stage: FactoryTask['stage'] | null, status: FactoryTask['status'] | null): FactoryNeedsYou['kind'] | null {
  if (!stage || !status || status === 'cancelled' || status === 'revoked') return null
  if (status === 'blocked' || status === 'failed') return status
  if (stage === 'clarify' && status === 'waiting') return 'question'
  if (stage === 'spec' && status === 'passed') return 'spec_review'
  return ['approval', 'publish', 'monitor'].includes(stage) ? 'pr_review' : null
}

/** Durable transition times, never the task's mutable updatedAt. */
function transitionWaits(events: TransitionRow[], attempts: AttemptRow[], endedAt: string | null, observedAt: string): FactoryActivityWait[] {
  const byId = new Map(attempts.map(attempt => [attempt.id, attempt]))
  const waits: FactoryActivityWait[] = []
  let open: FactoryActivityWait | null = null
  let revision = -1
  for (const event of events) {
    if (event.revision == null || event.revision <= revision || !event.stage || !event.status || !event.createdAt) continue
    revision = event.revision
    const at = iso(event.createdAt)!, kind = attention(event.stage, event.status)
    if ((open as FactoryActivityWait | null)?.kind === kind) continue
    if (open) { open.endedAt = at; waits.push(open); open = null }
    if (kind) open = { id: `event:${event.id}`, kind, attemptId: event.attemptId ?? null,
      runId: byId.get(event.attemptId)?.runId ?? null, startedAt: at, endedAt: null, durationMs: 0 }
  }
  if (open) { open.endedAt = endedAt; waits.push(open) }
  return waits.map(wait => ({ ...wait, durationMs: Math.max(0, Date.parse(wait.endedAt ?? observedAt) - Date.parse(wait.startedAt)) }))
}

/** An execution question can escalate without changing the task's stage/status. */
async function questionWaits(tx: PoolClient, task: FactoryTask, endedAt: string | null, observedAt: string) {
  const { rows } = await tx.query<{ id: string; attemptId: string; runId: string; status: string; startedAt: Instant; endedAt: Instant }>(
    `SELECT q.id,q."attemptId",q."originRunId" AS "runId",q.status,event."createdAt" AS "startedAt",
      LEAST(COALESCE(q."answeredAt",LEAST(
        CASE WHEN q."expiresAt"<=$5::timestamptz THEN q."expiresAt" END,
        CASE WHEN q.status IN ('cancelled','expired','superseded','resolved') THEN q."updatedAt" END)),replaced."createdAt") AS "endedAt"
     FROM factory_questions q
     JOIN factory_attempts attempt ON attempt.id=q."attemptId" AND attempt."taskId"=q."taskId" AND attempt."runId"=q."originRunId"
     JOIN agent_runs run ON run.id=q."originRunId" AND run."userId"=q."userId" AND run."issueId"=q."issueId"
     JOIN coordinator_events event ON event."dedupeKey"='question-escalated:'||q.id::text
       AND event."userId"=q."userId" AND event."issueId"=q."issueId" AND event."runId"=q."originRunId"
       AND event."botId" IS NOT DISTINCT FROM $4::uuid AND event.kind='run_question'
       AND event.payload->>'taskId'=q."taskId"::text AND event.payload->>'questionId'=q.id::text
       AND event.payload->>'needsUser'='true'
     LEFT JOIN LATERAL (SELECT changed."createdAt" FROM factory_events changed
       WHERE changed."taskId"=q."taskId" AND changed."createdAt">=event."createdAt"
         AND changed.result->'task'->>'id'=q."taskId"::text AND changed.result->'task' ? 'candidateId'
         AND changed.result->'task'->>'candidateId' IS DISTINCT FROM q."candidateId"::text
       ORDER BY changed."createdAt",changed."eventId" LIMIT 1) replaced ON true
     WHERE q."taskId"=$1 AND q."userId"=$2 AND q."issueId"=$3 ORDER BY event."createdAt",q.id`,
    [task.id,task.userId,task.issueId,task.botId,observedAt])
  const waits: FactoryActivityWait[] = rows.map(row => {
    const startedAt = iso(row.startedAt)!
    const end = [iso(row.endedAt),endedAt].filter((value): value is string => value !== null).sort()[0] ?? null
    return { id: `question:${row.id}`, kind: 'question', attemptId: row.attemptId, runId: row.runId,
      startedAt, endedAt: end, durationMs: Math.max(0,Date.parse(end ?? observedAt)-Date.parse(startedAt)) }
  })
  return { waits, hasWaitingReceipt: rows.some(row => row.status === 'waiting_user') }
}

/** All three right-hand tabs share one authorized, repeatable-read snapshot.
 * No model, provider, transcript, secret, or object-store access occurs here. */
export async function readFactoryActivity(pool: Pool, store: Pick<ReturnType<typeof createFactoryStore>, 'readTask'>, userId: string, taskId: string) {
  const tx = await pool.connect()
  try {
    // The canonical authorization takes shared locks to fence revocation.
    // Keep those locks even though this projection itself issues no writes.
    await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    const task = await store.readTask(tx, userId, taskId)
    const result = await withDatabaseClient(tx, () => projectFactoryActivity(tx, task))
    await tx.query('COMMIT')
    return result
  } catch (error) { await tx.query('ROLLBACK'); throw error }
  finally { tx.release() }
}

/** Caller has already applied the canonical owner/Bot/source/issue boundary. */
export async function projectFactoryActivity(tx: PoolClient, task: FactoryTask) {
  const flow = await readFactoryFlow(tx, task)
  const { rows: [times] } = await tx.query<{ createdAt: Instant; observedAt: Instant; mergedAt: Instant; acceptedAt: Instant; cancelledAt: Instant }>(
    `SELECT t."createdAt",transaction_timestamp() AS "observedAt",
      (SELECT min(m."finishedAt") FROM factory_merges m JOIN factory_candidates c ON c.id=m."candidateId" AND c."taskId"=m."taskId"
       WHERE m."taskId"=t.id AND m."candidateId"=t."candidateId" AND m."userId"=t."userId" AND m.status='merged' AND c.kind='repository') AS "mergedAt",
      (SELECT min(a."createdAt") FROM factory_deliverable_acceptances a JOIN factory_candidates c ON c.id=a."candidateId" AND c."taskId"=a."taskId"
       WHERE a."taskId"=t.id AND a."candidateId"=t."candidateId" AND a."userId"=t."userId" AND c.kind IN ('report','deliverable')) AS "acceptedAt",
      (SELECT min(e."createdAt") FROM factory_events e WHERE e."taskId"=t.id
       AND e.request->'change'->>'action' IN ('cancel','revoke') AND e.result->'task'->>'id'=t.id::text
       AND e.result->'task'->>'status' IN ('cancelled','revoked')) AS "cancelledAt"
     FROM factory_tasks t WHERE t.id=$1 AND t."userId"=$2`, [task.id, task.userId])
  const endedAtSource = flow.stage === 'cancelled' ? 'cancelled' : flow.completion === 'accepted' ? 'accepted'
    : flow.completion === 'merged' ? 'merged' : null
  const endedAt = iso(endedAtSource === 'cancelled' ? times.cancelledAt : endedAtSource === 'accepted' ? times.acceptedAt
    : endedAtSource === 'merged' ? times.mergedAt : null)
  const observedAt = iso(times.observedAt)!
  const { rows: allAttempts } = await tx.query<AttemptRow>(`SELECT a.id,a.stage,a.position,a.status,a."candidateId",a."createdAt",a."finishedAt",a.reason,
      a."runId" AS "boundRunId",r.id AS "runId",left(r.report->>'summary',4000) AS summary,left(a.output->'completion'->>'summary',4000) AS "completionSummary",
      COALESCE(a.output->>'requestEpoch',$4::text) AS "requestEpoch",a.output->>'reasonCode' AS "reasonCode",
      r.status AS "runStatus",r."createdAt" AS "runCreatedAt",r."startedAt",r."finishedAt" AS "runFinishedAt",r."agentId",
      left(COALESCE(r."agentDefinition"->'agentProfile'->>'name',r."agentDefinition"->>'name',agent.name),200) AS "agentName",
      left(COALESCE(r."agentDefinition"->>'harness',agent.harness),200) AS harness,left(r."agentDefinition"->>'model',200) AS model,
      device.id AS "deviceId",left(device.name,200) AS "deviceName",device.kind AS "deviceKind"
    FROM factory_attempts a
    LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$2 AND r."issueId"=$3
    LEFT JOIN agents agent ON agent.id=r."agentId" AND agent."userId"=$2
    LEFT JOIN devices device ON device.id=r."deviceId" AND device."ownerId"=$2
    WHERE a."taskId"=$1 ORDER BY a.position,a.id`, [task.id, task.userId, task.issueId, task.sourceEventId])
  const actor = actingContext.getStore()
  const scopedWorkspace = actor?.userId === task.userId ? actor.tokenWorkspaceId : undefined
  const hiddenRuns = scopedWorkspace ? await runsOutsideToken({ id: task.userId, [tokenWorkspace]: scopedWorkspace },
    allAttempts.flatMap(attempt => attempt.boundRunId ? [attempt.boundRunId] : [])) : new Set<string>()
  // A historical attempt may name another owner's/task's run. Its original
  // binding must stay hidden even though the authorized LEFT JOIN returned NULL.
  for (const attempt of allAttempts) if (attempt.boundRunId && !attempt.runId) hiddenRuns.add(attempt.boundRunId)
  const hiddenAttempts = new Set(allAttempts.filter(attempt => attempt.boundRunId && hiddenRuns.has(attempt.boundRunId)).map(attempt => attempt.id))
  const attempts = allAttempts.filter(attempt => !hiddenAttempts.has(attempt.id))
  const { rows: events } = await tx.query<TransitionRow>(`SELECT e."eventId" AS id,e."createdAt",e.request->'change'->>'action' AS action,
      e.request->>'kind' AS kind,e.result->'task'->>'attemptId' AS "attemptId",e.request->'binding'->>'attemptId' AS "previousAttemptId",
      e.result->'task'->>'stage' AS stage,e.result->'task'->>'status' AS status,
      CASE WHEN jsonb_typeof(e.result->'task'->'revision')='number' THEN (e.result->'task'->>'revision')::integer END AS revision,
      e.result->'task'->>'id' AS "taskId"
    FROM factory_events e WHERE e."taskId"=$1 AND e.result->'task'->>'id'=$1::text
    ORDER BY e."createdAt",revision,e."eventId"`, [task.id])
  const presentation = projectFactoryAttempts(attempts, events)
  const timelineAttempts = attempts.map(attempt => ({ id: attempt.id, runId: attempt.runId, candidateId: attempt.candidateId,
    position: attempt.position, ...presentation.get(attempt.id)!, status: attempt.status,
    artifactIds: [] as string[], plan: null as PlanReference | null,
    createdAt: iso(attempt.createdAt), startedAt: iso(attempt.startedAt), endedAt: iso(attempt.runId ? attempt.runFinishedAt : attempt.finishedAt) }))
  const agents = attempts.filter(attempt => attempt.runId !== null).map(attempt => ({
    attemptId: attempt.id, runId: attempt.runId!, candidateId: attempt.candidateId, ...presentation.get(attempt.id)!,
    status: attempt.runStatus, createdAt: iso(attempt.runCreatedAt), startedAt: iso(attempt.startedAt), endedAt: iso(attempt.runFinishedAt),
    agentId: attempt.agentId, name: text(attempt.agentName), harness: text(attempt.harness), model: text(attempt.model),
    machine: (!actor || actor.userId === task.userId) && attempt.deviceId ? { id: attempt.deviceId, name: text(attempt.deviceName), kind: attempt.deviceKind } : null,
    artifactIds: [] as string[], plan: null as PlanReference | null,
  }))
  const computers = !actor || actor.userId === task.userId ? (await readFactoryComputerSessions(tx, task)).filter(session => !hiddenRuns.has(session.runId)) : []
  const media = await readFactoryTaskMedia(tx, task)
  const documents = (await readFactoryActivityDocuments(tx, task)).filter(document => !hiddenRuns.has(document.runId))
  const { rows: publications } = await tx.query<{ runId: string; attemptId: string; candidateId: string | null; url: string; title: string | null; state: string | null; createdAt: Instant }>(
    `SELECT r.id AS "runId",attempt.id AS "attemptId",attempt."candidateId",p."pullRequest"->>'url' AS url,
      left(p."pullRequest"->>'title',200) AS title,p."pullRequest"->>'state' AS state,p."createdAt"
    FROM factory_attempts attempt JOIN agent_runs r ON r.id=attempt."runId" AND r."userId"=$2 AND r."issueId"=$3
    JOIN run_publications p ON p."runId"=r.id AND p."userId"=$2 AND p."issueId"=$3
    WHERE attempt."taskId"=$1 AND p.status='published' AND p."pullRequest" IS NOT NULL ORDER BY p."createdAt",r.id`,
    [task.id, task.userId, task.issueId])
  const attemptsByRun = new Map(attempts.filter(attempt => attempt.runId).map(attempt => [attempt.runId!,attempt.id]))
  const artifacts = [
    ...documents,
    ...media.map(capture => ({ ...capture, id: capture.captureId, attemptId: attemptsByRun.get(capture.runId) ?? null })),
    ...publications.filter(publication => !hiddenRuns.has(publication.runId)).flatMap(publication => {
      const url = githubPullRequest(publication.url)
      return url ? [{ id: `pr:${publication.runId}`, kind: 'pull_request' as const, title: text(publication.title), url,
        state: publication.state, runId: publication.runId, attemptId: publication.attemptId, candidateId: publication.candidateId,
        createdAt: iso(publication.createdAt) }] : []
    }),
  ].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id))
  const artifactsByRun = new Map<string, string[]>()
  for (const artifact of artifacts) {
    const ids = artifactsByRun.get(artifact.runId) ?? []
    ids.push(artifact.id); artifactsByRun.set(artifact.runId, ids)
  }
  const plans = new Map(documents.filter(document => document.kind === 'plan').map(document => [document.attemptId,
    { artifactId: document.artifactId, version: document.version, url: document.url }]))
  for (const attempt of timelineAttempts) {
    attempt.artifactIds = attempt.runId ? artifactsByRun.get(attempt.runId) ?? [] : []
    attempt.plan = plans.get(attempt.id) ?? null
  }
  for (const agent of agents) {
    agent.artifactIds = artifactsByRun.get(agent.runId) ?? []
    agent.plan = plans.get(agent.attemptId) ?? null
  }
  const questions = await questionWaits(tx, task, endedAt, observedAt)
  const waits = [...transitionWaits(events, allAttempts, endedAt, observedAt), ...questions.waits]
    .filter(wait => (!wait.runId || !hiddenRuns.has(wait.runId)) && (!wait.attemptId || !hiddenAttempts.has(wait.attemptId)))
  // Keep the existing current-attention contract even for legacy tasks whose
  // early transition receipts predate this read model.
  if (flow.needsYou && !hiddenAttempts.has(task.attemptId) && !(flow.needsYou.kind === 'question' && questions.hasWaitingReceipt)
      && !waits.some(wait => wait.kind === flow.needsYou!.kind && wait.endedAt === null)) {
    waits.push({ id: `attention:${task.attemptId}`, kind: flow.needsYou.kind, attemptId: task.attemptId,
      runId: attempts.find(attempt => attempt.id === task.attemptId)?.runId ?? null,
      startedAt: flow.needsYou.since, endedAt: null, durationMs: Math.max(0, Date.parse(observedAt) - Date.parse(flow.needsYou.since)) })
  }
  waits.sort((a,b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
  const starts = agents.flatMap(agent => agent.startedAt ? [agent.startedAt] : []).sort()
  // Embedded flow references obey the same producer and original-Artifact
  // boundaries as the sidebar collections. State/attention remain canonical.
  const visibleCaptures = new Set(media.map(capture => capture.captureId))
  const lastReview = allAttempts.findLast(attempt => attempt.stage === 'review' && attempt.boundRunId
    && ['passed','failed','blocked','waiting'].includes(attempt.status))
  const taskFlow = { ...flow,
    review: lastReview && hiddenAttempts.has(lastReview.id) ? null : flow.review,
    acceptance: scopedWorkspace && flow.acceptance ? documents.some(document => document.kind === 'acceptance'
      && document.artifactId === flow.acceptance!.artifactId && document.version === flow.acceptance!.version
      && document.runId === flow.acceptance!.runId && document.candidateId === flow.acceptance!.candidateId)
      ? { ...flow.acceptance, media: flow.acceptance.media.filter(capture => visibleCaptures.has(capture.captureId)) } : null : flow.acceptance,
    pullRequest: scopedWorkspace && flow.pullRequest
      && !artifacts.some(artifact => artifact.kind === 'pull_request' && artifact.url === flow.pullRequest!.url) ? null : flow.pullRequest,
  }
  return {
    version: 1 as const, observedAt,
    task: { ...taskFlow, status: task.status, createdAt: iso(times.createdAt), startedAt: starts[0] ?? null,
      endedAt, endedAtSource: endedAt ? endedAtSource : null },
    timeline: { attempts: timelineAttempts, computers, waits }, agents, artifacts,
  }
}

export type FactoryActivitySnapshot = Awaited<ReturnType<typeof readFactoryActivity>>
/** HTTP response: the route adds the authorized live subscription scope. */
export type FactoryActivityView = FactoryActivitySnapshot & { liveWorkspaceId: string | null }
